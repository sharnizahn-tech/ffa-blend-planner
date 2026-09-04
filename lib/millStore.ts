// Per-mill data storage, backed by Cloudflare R2 (S3-compatible object storage).
//
// Each mill's entire state — tanks, settings, buyer profiles — is stored as
// ONE JSON object at `mills/<id>.json`. There's no login: the mill's unique
// ID (embedded in its URL, /m/<id>) IS the access control. Anyone who opens
// that link reads and writes this same record, so every engineer on every
// device sees the same live numbers instead of whatever's in their own
// browser's memory.

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { z } from "zod";
import { createEmptyBuyerProfile, type BuyerProfile } from "./penalty";
import { DEFAULT_RISE_FACTOR_PER_DAY, DEFAULT_HORIZON_DAYS } from "./prediction";
import { DEFAULT_MAX_TRANSFER_PER_DAY_MT } from "./lossOptimizer";

const millTankSchema = z.object({
  name: z.string().min(1).max(80),
  capacity: z.number().finite().nonnegative(),
  stock: z.number().finite(),
  ffa: z.number().finite(),
});

const penaltyBandSchema = z.object({
  id: z.string().min(1),
  minFfaPct: z.number().finite(),
  maxFfaPct: z.number().finite().nullable(),
  deductionRmPerMt: z.number().finite(),
});

const buyerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  bands: z.array(penaltyBandSchema).max(50),
});

/** What a client is allowed to write. `updatedAt` is server-assigned, never
 *  taken from the request, so a client can't spoof staleness checks later. */
export const millStateInputSchema = z.object({
  tanks: z.array(millTankSchema).min(1).max(30),
  millCapacity: z.number().finite().nonnegative(),
  hours: z.number().finite().nonnegative(),
  utilisation: z.number().finite(),
  oer: z.number().finite(),
  incomingFFA: z.number().finite(),
  target: z.number().finite(),
  deadStockMt: z.number().finite().nonnegative(),
  allocation: z.array(z.number().finite()).min(1).max(30),
  tankerLoadMt: z.number().finite().nonnegative(),
  buyerProfiles: z.array(buyerProfileSchema).max(20),
  activeProfileId: z.string(),
  riseFactorPerDay: z.number().finite(),
  horizonDays: z.number().finite().nonnegative(),
  preferFewerTanks: z.boolean(),
  scenarios: z
    .array(
      z.object({
        id: z.string().min(1),
        millCapacity: z.number().finite(),
        hours: z.number().finite(),
        utilisation: z.number().finite(),
        oer: z.number().finite(),
        incomingFFA: z.number().finite(),
      }),
    )
    .max(10),
  manualMaxTransferPerDayMt: z.number().finite().nonnegative(),
  autoTransfer: z.boolean(),
  lang: z.enum(["en", "bm"]),
});

export type MillTank = { name: string; capacity: number; stock: number; ffa: number };

export type MillStateInput = z.infer<typeof millStateInputSchema>;
export type MillState = MillStateInput & {
  /** Server-side bookkeeping, not client-editable — stamped on every save. */
  updatedAt: string;
};

const DEFAULT_TANKS: MillTank[] = [
  { name: "BST 1", capacity: 2000, stock: 465, ffa: 4.54 },
  { name: "BST 2", capacity: 2000, stock: 716, ffa: 6.23 },
];

export function defaultMillState(): MillState {
  const buyerProfiles = [createEmptyBuyerProfile("Buyer 1")];
  return {
    tanks: DEFAULT_TANKS,
    millCapacity: 40,
    hours: 20,
    utilisation: 100,
    oer: 19,
    incomingFFA: 6.7,
    target: 4.8,
    deadStockMt: 200,
    allocation: [0, 100],
    tankerLoadMt: 38,
    buyerProfiles,
    activeProfileId: buyerProfiles[0].id,
    riseFactorPerDay: DEFAULT_RISE_FACTOR_PER_DAY,
    horizonDays: DEFAULT_HORIZON_DAYS,
    preferFewerTanks: true,
    scenarios: [
      { id: "b", millCapacity: 40, hours: 22, utilisation: 100, oer: 19, incomingFFA: 6.7 },
      { id: "c", millCapacity: 40, hours: 18, utilisation: 100, oer: 19, incomingFFA: 6.7 },
    ],
    manualMaxTransferPerDayMt: DEFAULT_MAX_TRANSFER_PER_DAY_MT,
    autoTransfer: true,
    lang: "en",
    updatedAt: new Date().toISOString(),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let cachedClient: S3Client | null = null;
function client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: "auto",
    endpoint: requiredEnv("R2_ENDPOINT"),
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
  return cachedClient;
}

function bucketName(): string {
  return requiredEnv("R2_BUCKET_NAME");
}

/** Mill IDs are validated everywhere they cross a trust boundary (URL param,
 *  request body) so a malformed or hostile value can never be turned into an
 *  R2 object key / path traversal. */
const MILL_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;
export function isValidMillId(id: string): boolean {
  return MILL_ID_PATTERN.test(id);
}

function objectKey(millId: string): string {
  return `mills/${millId}.json`;
}

export async function millExists(millId: string): Promise<boolean> {
  if (!isValidMillId(millId)) return false;
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucketName(), Key: objectKey(millId) }));
    return true;
  } catch {
    return false;
  }
}

export async function getMillState(millId: string): Promise<MillState | null> {
  if (!isValidMillId(millId)) return null;
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: bucketName(), Key: objectKey(millId) }),
    );
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as MillState;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

export async function saveMillState(millId: string, state: MillStateInput): Promise<void> {
  if (!isValidMillId(millId)) throw new Error("Invalid mill id");
  const withTimestamp: MillState = { ...state, updatedAt: new Date().toISOString() };
  await client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: objectKey(millId),
      Body: JSON.stringify(withTimestamp),
      ContentType: "application/json",
    }),
  );
}

/** Creates a brand-new mill with default demo data and returns its ID. */
export async function createMill(): Promise<string> {
  const id = randomUUID();
  await saveMillState(id, defaultMillState());
  return id;
}
