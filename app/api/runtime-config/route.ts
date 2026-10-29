import { handleRuntimeConfig } from "@/lib/grading/server-runtime.mjs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return handleRuntimeConfig(request); }
