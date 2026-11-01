import { createProductionServices } from "../../../../server/composition";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return createProductionServices(process.env).image().analyze(request);
}
