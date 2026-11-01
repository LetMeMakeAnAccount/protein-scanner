import { createHealthHandlers } from "../../../server/composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> { return createHealthHandlers(process.env).health(); }
