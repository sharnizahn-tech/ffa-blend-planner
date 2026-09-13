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
  if (cmd.__type === "delete") {
    store.delete(cmd.input.Key);
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
  DeleteObjectCommand: fakeCommand("delete"),
}));

process.env.R2_ENDPOINT ??= "https://example.test";
process.env.R2_ACCESS_KEY_ID ??= "test-key";
process.env.R2_SECRET_ACCESS_KEY ??= "test-secret";
process.env.R2_BUCKET_NAME ??= "test-bucket";

const {
  getMillState,
  saveMillState,
  millExists,
  isValidMillId,
  MillSaveConflictError,
  defaultMillState,
  getPreviousMillState,
  undoLastSave,
} = await import("./millStore");

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

  it("a no-op save (identical data) is a true no-op: same updatedAt, no write dispatched", async () => {
    const id = "99999999-9999-9999-9999-999999999999";
    // sampleState() mints a fresh buyerProfiles[0].id each call (it's
    // Date.now()-based) — reuse ONE object so both saves are genuinely
    // identical, not just similar.
    const state = sampleState();
    const first = await saveMillState(id, state);
    send.mockClear();
    const second = await saveMillState(id, state);
    expect(second.updatedAt).toBe(first.updatedAt);
    // The one call that DOES happen is the read to check for a no-op —
    // no PutObjectCommand (current-state save or undo-slot snapshot).
    const putCalls = send.mock.calls.filter((c) => (c[0] as { __type: string }).__type === "put");
    expect(putCalls.length).toBe(0);
  });

  it("a no-op save does not clobber a REAL previous version with a duplicate of the current one", async () => {
    // This is the exact bug this fix closes: state A saved, state B saved
    // (so undo can restore A) — then something re-submits B unchanged
    // (e.g. a page re-hydrating). Undo must still restore A, not B.
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const stateA = sampleState();
    stateA.tankerLoadMt = 11;
    await saveMillState(id, stateA);

    const stateB = sampleState();
    stateB.tankerLoadMt = 22;
    await saveMillState(id, stateB);

    // A no-op re-save of the CURRENT state (B) — must not touch the undo slot.
    await saveMillState(id, stateB);

    const restored = await undoLastSave(id);
    expect(restored?.tankerLoadMt).toBe(11);
  });
});

describe("undo (one level)", () => {
  beforeEach(() => {
    store.clear();
    send.mockClear();
  });

  it("has nothing to undo before any save has happened", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    expect(await getPreviousMillState(id)).toBeNull();
    expect(await undoLastSave(id)).toBeNull();
  });

  it("has nothing to undo after only ONE save (nothing came before it)", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    await saveMillState(id, sampleState());
    expect(await getPreviousMillState(id)).toBeNull();
    expect(await undoLastSave(id)).toBeNull();
  });

  it("restores the state from just before the most recent save", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const first = sampleState();
    first.tankerLoadMt = 40;
    await saveMillState(id, first);

    const second = sampleState();
    second.tankerLoadMt = 99; // the "fat-fingered" change
    await saveMillState(id, second);

    const restored = await undoLastSave(id);
    expect(restored?.tankerLoadMt).toBe(40); // back to what it was before the last save

    const loaded = await getMillState(id);
    expect(loaded?.tankerLoadMt).toBe(40);
    expect(loaded?.updatedAt).toBe(restored?.updatedAt);
  });

  it("is a single one-shot revert, not a redo-able stack", async () => {
    const id = "88888888-8888-8888-8888-888888888888";
    await saveMillState(id, sampleState());
    await saveMillState(id, sampleState());

    expect(await undoLastSave(id)).not.toBeNull();
    // The undo slot is cleared after use — undoing again finds nothing.
    expect(await undoLastSave(id)).toBeNull();
  });
});
