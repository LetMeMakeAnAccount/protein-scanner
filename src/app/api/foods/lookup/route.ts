import { createProductionServices } from "../../../../server/composition";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> { return createProductionServices(process.env).lookup().lookup(request); }
