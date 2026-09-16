import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const COOKIE_NAME = "user-api-key";

/** Check if a global API key is configured in the environment */
function hasGlobalKey(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/** GET – returns whether the user needs to provide a key */
export async function GET() {
  const jar = await cookies();
  const userKey = jar.get(COOKIE_NAME)?.value;

  return NextResponse.json({
    hasGlobalKey: hasGlobalKey(),
    hasUserKey: !!userKey,
  });
}

/** POST – save or delete the user's API key */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    apiKey?: string;
    action?: "save" | "delete";
  };

  const jar = await cookies();

  if (body.action === "delete") {
    jar.delete(COOKIE_NAME);
    return NextResponse.json({ ok: true });
  }

  const apiKey = body.apiKey?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }

  // Basic validation
  if (!apiKey.startsWith("sk-or-")) {
    return NextResponse.json(
      { error: "OpenRouter keys start with sk-or-" },
      { status: 400 },
    );
  }

  jar.set(COOKIE_NAME, apiKey, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });

  return NextResponse.json({ ok: true });
}
