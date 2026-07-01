import { timingSafeEqual } from "crypto";

import { db } from "@/db/client";
import { bookmarks, categories } from "@/db/schema";
import { directory } from "@/directory.config";
import { generateSlug } from "@/lib/utils";
import { asc, eq, ilike, or, sql } from "drizzle-orm";
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

const reservedTopLevelSlugs = new Set([
  "about",
  "account",
  "api",
  "auth",
  "badge",
  "c",
  "fonts",
  "go",
  "hi-studio",
  "legal",
  "login",
  "pricing",
  "submit",
]);

const payloadSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(180),
  tagline: z.string().trim().max(300).nullish(),
  description: z.string().trim().max(50000).nullish(),
  websiteUrl: webUrlSchema,
  logoUrl: webUrlSchema.nullish(),
  coverImageUrl: webUrlSchema.nullish(),
  images: z.array(webUrlSchema).max(8).nullish(),
  pricing: z.enum(["free", "freemium", "paid"]).nullish(),
  categoryName: z.string().trim().max(120).nullish(),
  tier: z.string().trim().max(60).nullish(),
  rel: z.enum(["nofollow"]).nullish(),
  targetSiteId: z.string().trim().max(100).nullish(),
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

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    directory.baseUrl ||
    "https://hicyou.com"
  ).replace(/\/+$/, "");
}

function normalizeUrlForCompare(input: string): string {
  return input
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function pricingType(
  input: string | null | undefined,
  isSkillLaunch: boolean,
): string {
  switch ((input ?? "").toLowerCase()) {
    case "free":
      return "Free";
    case "freemium":
      return "Freemium";
    case "paid":
      return "Paid";
    default:
      return isSkillLaunch ? "Free" : "Paid";
  }
}

function slugBase(name: string, websiteUrl: string): string {
  const fromName = generateSlug(name);
  if (fromName) return fromName;

  try {
    return generateSlug(new URL(websiteUrl).hostname.replace(/^www\./, ""));
  } catch {
    return `external-${Date.now()}`;
  }
}

async function uniqueSlug(name: string, websiteUrl: string): Promise<string> {
  const base = slugBase(name, websiteUrl) || `external-${Date.now()}`;

  for (let suffix = 1; suffix < 100; suffix += 1) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    if (reservedTopLevelSlugs.has(slug)) continue;

    const [existing] = await db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(eq(bookmarks.slug, slug))
      .limit(1);

    if (!existing) return slug;
  }

  return `${base}-${Date.now()}`;
}

async function resolveCategoryId(
  categoryName?: string | null,
): Promise<number | null> {
  const defaultSlug = process.env.EXTERNAL_LAUNCH_DEFAULT_CATEGORY_SLUG;
  if (defaultSlug) {
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, defaultSlug))
      .limit(1);
    if (category) return category.id;
  }

  if (categoryName) {
    const slug = generateSlug(categoryName);
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        or(
          ilike(categories.name, categoryName),
          ilike(categories.slug, slug || categoryName),
        ),
      )
      .limit(1);
    if (category) return category.id;
  }

  const [fallback] = await db
    .select({ id: categories.id })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.id))
    .limit(1);

  return fallback?.id ?? null;
}

function uniqueViolationConstraint(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const constraint =
      (error as { constraint?: unknown }).constraint ??
      (error as { cause?: { constraint?: unknown } }).cause?.constraint;
    if (typeof constraint === "string") return constraint;
  }

  return null;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code =
      (error as { code?: unknown }).code ??
      (error as { cause?: { code?: unknown } }).cause?.code;
    if (code === "23505") return true;
  }

  return (
    error instanceof Error &&
    /duplicate key value|unique constraint/i.test(error.message)
  );
}

async function existingByExternalKey(idempotencyKey: string) {
  const [existing] = await db
    .select({ id: bookmarks.id, slug: bookmarks.slug })
    .from(bookmarks)
    .where(eq(bookmarks.externalLaunchKey, idempotencyKey))
    .limit(1);

  return existing;
}

async function existingByNormalizedUrl(normalizedUrl: string) {
  const [existing] = await db
    .select({
      id: bookmarks.id,
      slug: bookmarks.slug,
      externalLaunchKey: bookmarks.externalLaunchKey,
    })
    .from(bookmarks)
    .where(
      sql`lower(regexp_replace(regexp_replace(${bookmarks.url}, '^https?://', '', 'i'), '/+$', '')) = ${normalizedUrl}`,
    )
    .limit(1);

  return existing;
}

async function insertBookmarkWithSlugRetry(
  values: typeof bookmarks.$inferInsert,
  input: { name: string; websiteUrl: string },
) {
  let insertValues = values;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [bookmark] = await db
        .insert(bookmarks)
        .values(insertValues)
        .returning({ id: bookmarks.id, slug: bookmarks.slug });
      return bookmark;
    } catch (error) {
      if (
        uniqueViolationConstraint(error) !== "bookmarks_slug_unique" ||
        attempt === 4
      ) {
        throw error;
      }

      insertValues = {
        ...values,
        slug: await uniqueSlug(
          `${input.name}-${attempt + 2}`,
          input.websiteUrl,
        ),
      };
    }
  }

  throw new Error("Failed to create a unique slug");
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

  const data = parsed.data;
  const isSkillLaunch =
    data.rel === "nofollow" || data.tier?.toLowerCase() === "free-skill";

  const baseUrl = siteUrl();
  const normalizedUrl = normalizeUrlForCompare(data.websiteUrl);

  try {
    const existingByKey = await existingByExternalKey(data.idempotencyKey);
    if (existingByKey) {
      return NextResponse.json({
        ok: true,
        deduped: true,
        id: existingByKey.id,
        slug: existingByKey.slug,
        url: `${baseUrl}/${existingByKey.slug}`,
      });
    }

    const existingByUrl = await existingByNormalizedUrl(normalizedUrl);
    if (existingByUrl) {
      if (existingByUrl.externalLaunchKey !== data.idempotencyKey) {
        return NextResponse.json(
          { error: "A listing for this URL already exists on this site" },
          { status: 409 },
        );
      }

      return NextResponse.json({
        ok: true,
        deduped: true,
        id: existingByUrl.id,
        slug: existingByUrl.slug,
        url: `${baseUrl}/${existingByUrl.slug}`,
      });
    }

    const now = new Date();
    const slug = await uniqueSlug(data.name, data.websiteUrl);
    const categoryId = await resolveCategoryId(data.categoryName);
    const coverImage = data.coverImageUrl ?? data.images?.[0] ?? null;

    const bookmark = await insertBookmarkWithSlugRetry(
      {
        url: data.websiteUrl,
        title: data.name,
        slug,
        description: data.tagline ?? null,
        categoryId,
        favicon: data.logoUrl ?? null,
        screenshot: coverImage,
        overview: data.description ?? null,
        pricingType: pricingType(data.pricing, isSkillLaunch),
        ogImage: coverImage,
        ogTitle: data.name,
        ogDescription: data.tagline ?? null,
        isArchived: false,
        isFavorite: false,
        isDofollow: isSkillLaunch ? false : true,
        externalLaunchKey: data.idempotencyKey,
        externalLaunchSource: data.source ?? "aat.ee",
        createdAt: now,
        updatedAt: now,
      },
      { name: data.name, websiteUrl: data.websiteUrl },
    );

    revalidatePath("/", "layout");

    return NextResponse.json(
      {
        ok: true,
        deduped: false,
        id: bookmark.id,
        slug: bookmark.slug,
        url: `${baseUrl}/${bookmark.slug}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await existingByExternalKey(data.idempotencyKey);
      if (existing) {
        return NextResponse.json({
          ok: true,
          deduped: true,
          id: existing.id,
          slug: existing.slug,
          url: `${baseUrl}/${existing.slug}`,
        });
      }

      if (uniqueViolationConstraint(error) === "bookmarks_url_unique") {
        const existingByUrl = await existingByNormalizedUrl(normalizedUrl);
        if (existingByUrl) {
          return NextResponse.json(
            { error: "A listing for this URL already exists on this site" },
            { status: 409 },
          );
        }
      }
    }

    console.error("[external/launch] failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
