// functions/escalation-data.js
//
// Contentstack Launch Cloud Function.
// Endpoint path is determined by this file's location: /functions/escalation-data.js
// deployed to Launch becomes callable at: https://<your-launch-domain>/escalation-data
//
// Required environment variables (set in Launch project > Environment > Settings):
//   SF_LOGIN_URL     e.g. https://contentstack.my.salesforce.com  (your org's login/instance URL)
//   SF_CLIENT_ID     Connected App consumer key
//   SF_CLIENT_SECRET Connected App consumer secret
//   SF_REFRESH_TOKEN Refresh token obtained once via OAuth authorization-code flow
//
// This function does NOT store or expose these values to the browser -- it runs
// server-side, authenticates to Salesforce on each request, runs the same SOQL
// queries used to build this dashboard by hand, and returns clean JSON.

async function getAccessToken(env) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.SF_CLIENT_ID,
    client_secret: env.SF_CLIENT_SECRET,
    refresh_token: env.SF_REFRESH_TOKEN,
  });

  const resp = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Salesforce auth failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return { accessToken: data.access_token, instanceUrl: data.instance_url };
}

async function runSoql(instanceUrl, accessToken, soql) {
  const url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SOQL failed (${resp.status}): ${soql} -- ${text}`);
  }
  const data = await resp.json();
  return data.records || [];
}

// Resolves a friendly period key (e.g. "last_week", "this_month") into an explicit
// date range, so the frontend can ask for whichever period the user has selected.
function resolvePeriod(period) {
  const now = new Date();
  if (period === "last_week") {
    // Salesforce LAST_WEEK is Mon-Sun of the prior calendar week relative to today.
    return { soqlDateClause: "CreatedDate = LAST_WEEK" };
  }
  if (period === "this_month") {
    return { soqlDateClause: "CreatedDate = THIS_MONTH" };
  }
  if (period === "last_month") {
    return { soqlDateClause: "CreatedDate = LAST_MONTH" };
  }
  if (period === "ytd") {
    // Feb 1 of the current year through now -- matches the "Feb-Till Date"
    // view used across the other reports in this hub.
    const year = now.getFullYear();
    return { soqlDateClause: `CreatedDate >= ${year}-02-01T00:00:00Z AND CreatedDate <= ${now.toISOString()}` };
  }
  // Fallback: last 7 days
  return { soqlDateClause: "CreatedDate = LAST_N_DAYS:7" };
}

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") || "last_week";
    const { soqlDateClause } = resolvePeriod(period);

    // Pull env vars (Launch cloud functions receive these via process.env)
    const env = {
      SF_LOGIN_URL: process.env.SF_LOGIN_URL,
      SF_CLIENT_ID: process.env.SF_CLIENT_ID,
      SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET,
      SF_REFRESH_TOKEN: process.env.SF_REFRESH_TOKEN,
    };
    for (const [key, val] of Object.entries(env)) {
      if (!val) throw new Error(`Missing required environment variable: ${key}`);
    }

    const { accessToken, instanceUrl } = await getAccessToken(env);

    // ---- 1. Overall T1/T2/T3 distribution ----
    const distRows = await runSoql(
      instanceUrl,
      accessToken,
      `SELECT Team_Responsible__c, COUNT(Id) cnt FROM Case WHERE ${soqlDateClause} GROUP BY Team_Responsible__c`
    );
    const dist = { T1: 0, T2: 0, T3: 0 };
    distRows.forEach((r) => {
      if (r.Team_Responsible__c && dist.hasOwnProperty(r.Team_Responsible__c)) {
        dist[r.Team_Responsible__c] = r.cnt;
      }
    });
    const total = dist.T1 + dist.T2 + dist.T3;

    // ---- 2. T1 solve rate (Status breakdown among T1) ----
    const statusRows = await runSoql(
      instanceUrl,
      accessToken,
      `SELECT Status, COUNT(Id) cnt FROM Case WHERE ${soqlDateClause} AND Team_Responsible__c = 'T1' GROUP BY Status`
    );
    let t1Solved = 0;
    statusRows.forEach((r) => {
      if (r.Status === "Solved" || r.Status === "Closed") t1Solved += r.cnt;
    });
    const t1Open = dist.T1 - t1Solved;

    // ---- 3. T1 solved-by-agent, JIRA-Key-corrected ----
    const solvedByAgent = await runSoql(
      instanceUrl,
      accessToken,
      `SELECT Owner.Name nm, COUNT(Id) cnt FROM Case WHERE ${soqlDateClause} AND Team_Responsible__c = 'T1' AND Status IN ('Solved','Closed') AND JIRA_Key__c = null GROUP BY Owner.Name ORDER BY COUNT(Id) DESC`
    );
    const jiraDirectByAgent = await runSoql(
      instanceUrl,
      accessToken,
      `SELECT Owner.Name nm, COUNT(Id) cnt FROM Case WHERE ${soqlDateClause} AND Team_Responsible__c = 'T1' AND Status IN ('Solved','Closed') AND JIRA_Key__c != null GROUP BY Owner.Name ORDER BY COUNT(Id) DESC`
    );
    const escalatedByAgent = await runSoql(
      instanceUrl,
      accessToken,
      `SELECT CreatedBy.Name nm, COUNT(Id) cnt FROM CaseHistory WHERE CaseId IN (SELECT Id FROM Case WHERE ${soqlDateClause}) AND Field = 'Team_Responsible__c' AND CreatedBy.Name != 'JIRA Integration' GROUP BY CreatedBy.Name ORDER BY COUNT(Id) DESC`
    );

    const jiraMap = Object.fromEntries(jiraDirectByAgent.map((r) => [r.nm, r.cnt]));
    const escMap = Object.fromEntries(escalatedByAgent.map((r) => [r.nm, r.cnt]));
    const excludeNames = ["Spam Cases", "CDP Team"];

    const t1Agents = solvedByAgent
      .filter((r) => !excludeNames.includes(r.nm))
      .map((r) => {
        const solved = r.cnt;
        const esc2 = escMap[r.nm] || 0;
        const esc3 = jiraMap[r.nm] || 0;
        const totalHandled = solved + esc2 + esc3;
        const pct = totalHandled > 0 ? Math.round((solved / totalHandled) * 1000) / 10 : 0;
        return { name: r.nm, solved, esc2, esc3, total: totalHandled, solvePct: pct };
      })
      .sort((a, b) => b.total - a.total);

    return new Response(
      JSON.stringify({
        period,
        generatedAt: new Date().toISOString(),
        kpi: {
          total,
          t1: dist.T1,
          t2: dist.T2,
          t3: dist.T3,
          t1Pct: total ? Math.round((dist.T1 / total) * 1000) / 10 : 0,
          t2Pct: total ? Math.round((dist.T2 / total) * 1000) / 10 : 0,
          t3Pct: total ? Math.round((dist.T3 / total) * 1000) / 10 : 0,
          t1Solved,
          t1Open,
          t1SolvedPct: dist.T1 ? Math.round((t1Solved / dist.T1) * 1000) / 10 : 0,
        },
        t1Agents,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Cache for 5 minutes at the edge -- balances "dynamic" against not
          // hammering Salesforce on every single page view.
          "Cache-Control": "public, max-age=300",
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
