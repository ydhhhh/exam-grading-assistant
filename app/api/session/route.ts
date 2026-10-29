import { handleSession } from "@/lib/grading/server-runtime.mjs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleSession(request); }
export async function DELETE(request: Request) { return handleSession(request); }
