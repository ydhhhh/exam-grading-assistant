import { handleRuntimeAPI } from "@/lib/grading/api-service.mjs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleRuntimeAPI(request, "identity"); }
