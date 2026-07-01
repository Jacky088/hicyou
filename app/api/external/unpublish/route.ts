import { timingSafeEqual } from "crypto";

import { db } from "@/db/client";
import { bookmarks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const webUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Expected an http(s) URL" },
  );

const payloadSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(100).optional(),
  targetSiteId: z.string().trim().max(100).optional(),
  websiteUrl: webUrlSchema.nullish(),
});

function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

export async function POST(request: NextRequest) {
  const expected = process.env.EXTERNAL_LAUNCH_API_KEY;
  if (!expected) {
    console.error("EXTERNAL_LAUNCH_API_KEY is not configured");
    return NextResponse.json(
      { error: "External launch not configured" },
      { status: 500 },
    );
  }

  const token = bearerToken(request);
  if (!token || !safeEqual(token, expected)) return unauthorized();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const [existing] = await db
      .select({ id: bookmarks.id, slug: bookmarks.slug })
      .from(bookmarks)
      .where(eq(bookmarks.externalLaunchKey, parsed.data.idempotencyKey))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ ok: true, unpublished: false });
    }

    await db.delete(bookmarks).where(eq(bookmarks.id, existing.id));

    revalidatePath("/", "layout");

    return NextResponse.json({
      ok: true,
      unpublished: true,
      id: existing.id,
      slug: existing.slug,
    });
  } catch (error) {
    console.error("[external/unpublish] failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
