import { createProductionServices } from "../../../../server/composition";

export const runtime = "nodejs";
// Netlify sync functions default to a 10s budget; this segment asks for the
// longest supported ceiling where the platform honours it.
export const maxDuration = 26;
export async function POST(request: Request): Promise<Response> {
  return createProductionServices(process.env).image().analyze(request);
}
