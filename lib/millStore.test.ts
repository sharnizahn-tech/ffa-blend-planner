import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory fake for the one S3 operation this module actually
// depends on ("send a command, get a response") — avoids any real network
// call or dependency on live R2 credentials while still exercising the
// real conditional-save logic in millStore.ts.
type FakeObject = { body: string };
const store = new Map<string, FakeObject>();

const send = vi.fn(async (command: unknown) => {
  const cmd = command as { __type: string; input: { Key: string; Body?: string } };
  if (cmd.__type === "put") {
    store.set(cmd.input.Key, { body: cmd.input.Body ?? "" });
    return {};
  }
  if (cmd.__type === "get") {
    const obj = store.get(cmd.input.Key);
    if (!obj) {
      const err = new Error("not found");
      (err as { name?: string }).name = "NoSuchKey";
      throw err;
    }
    return { Body: { transformToString: async () => obj.body } };
  }
  if (cmd.__type === "head") {
    if (!store.has(cmd.input.Key)) {
      const err = new Error("not found");
      (err as { name?: string }).name = "NotFound";
      throw err;
    }
    return {};
  }
  throw new Error(`unhandled fake command ${cmd.__type}`);
});

function fakeCommand(type: string) {
  return vi.fn().mockImplementation(function FakeCommand(this: { __type: string; input: unknown }, input: unknown) {
    this.__type = type;
    this.input = input;
  });
}

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(function FakeS3Client() {
    return { send };
  }),
  GetObjectCommand: fakeCommand("get"),
  PutObjectCommand: fakeCommand("put"),
  HeadObjectCommand: fakeCommand("head"),
}));

process.env.R2_ENDPOINT ??= "https://example.test";
process.env.R2_ACCESS_KEY_ID ??= "test-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret";
process.env.R2_BUCKET_NAME ??= "test-bucket";

const { getMillState, saveMillState, millExists, isValidMillId, MillSaveConflictError, defaultMillState } =
  await import("./millStore");

function sampleState() {
  const base = defaultMillState();
  // defaultMillState carries `updatedAt`, which isn't part of MillStateInput
  const { updatedAt: _unused, ...input } = base;
  return input;
}

describe("isValidMillId", () => {
  it("accepts a real UUID", () => {
    expect(isValidMillId("dc38610c-8344-4757-bb6f-d50bc1e88d24")).toBe(true);
  });

  it("rejects anything with characters outside hex/hyphen, or the wrong length", () => {
    expect(isValidMillId("not-a-valid-id-at-all-!!")).toBe(false);
    expect(isValidMillId("abc")).toBe(false); // too short
    expect(isValidMillId("a".repeat(65))).toBe(false); // too long
  });
});

describe("saveMillState / getMillState round-trip", () => {
  beforeEach(() => {
    store.clear();
    send.mockClear();
  });

  it("saves unconditionally when no expectedUpdatedAt is given", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const result = await saveMillState(id, sampleState());
    expect(result.updatedAt).toBeTruthy();
    const loaded = await getMillState(id);
    expect(loaded?.updatedAt).toBe(result.updatedAt);
    expect(await millExists(id)).toBe(true);
  });

  it("succeeds when expectedUpdatedAt matches the current stored value", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const first = await saveMillState(id, sampleState());
    const second = await saveMillState(id, sampleState(), first.updatedAt);
    expect(second.updatedAt).toBeTruthy();
  });

  it("rejects with MillSaveConflictError when expectedUpdatedAt is stale, reporting the real current version", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    await saveMillState(id, sampleState());
    // Someone else saves in between...
    const someoneElse = await saveMillState(id, sampleState());
    // ...and now this client tries to save against the OLD (now-stale) version.
    let caught: unknown;
    try {
      await saveMillState(id, sampleState(), "2000-01-01T00:00:00.000Z");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MillSaveConflictError);
    expect((caught as InstanceType<typeof MillSaveConflictError>).currentUpdatedAt).toBe(someoneElse.updatedAt);
  });

  it("does not conflict against a mill that doesn't exist yet", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    // Passing an expectedUpdatedAt for a brand-new id should just save —
    // there's nothing to conflict with.
    const result = await saveMillState(id, sampleState(), "2020-01-01T00:00:00.000Z");
    expect(result.updatedAt).toBeTruthy();
  });
});
