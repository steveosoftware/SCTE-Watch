// AWS Lambda entrypoint for the two API routes, fronted by an HTTP API
// (API Gateway v2) behind an Amplify Hosting rewrite (see ROADMAP.md
// Phase 3). Pure request logic lives in ../api-handlers.js — this file is
// just the Lambda-shaped transport wrapper, the same role server.js plays
// for local dev via node:http.

import { handleFetchRequest, handleDnsChainRequest } from "../api-handlers.js";

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const path = event.rawPath || "";
  const qs = event.queryStringParameters || {};

  if (path.endsWith("/api/fetch")) {
    const { status, body } = await handleFetchRequest(qs.url);
    return json(status, body);
  }
  if (path.endsWith("/api/dns-chain")) {
    const { status, body } = await handleDnsChainRequest(qs.hostname);
    return json(status, body);
  }
  return json(404, { error: "not found" });
};
