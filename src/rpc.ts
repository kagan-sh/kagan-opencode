import { Rpc } from "@opencode/plugin/rpc"
import type { Snapshot } from "./kit.ts"

/** What the TUI receives. Mirrors `Snapshot`, which the server part returns. */
export type WireSnapshot = Snapshot
export type WireReply = { ok: boolean; message: string }
export type WireDiff = { text: string; hash: string; patch: string }

const one = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
const bound = {
  type: "object",
  properties: { id: { type: "string" }, hash: { type: "string" } },
  required: ["id", "hash"],
  additionalProperties: false,
}
const reply = {
  type: "object",
  properties: { ok: { type: "boolean" }, message: { type: "string" } },
  required: ["ok", "message"],
  additionalProperties: false,
}

/**
 * The contract between the server part, which can touch files, and the TUI part,
 * which can ask a person. Only the server part registers it.
 */
export const Kit = Rpc.define({
  id: "kagan.ext",
  methods: {
    snapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          staged: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, installed: { type: "boolean" } },
              required: ["id", "installed"],
              additionalProperties: false,
            },
          },
          installed: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                status: { type: "string", enum: ["active", "failed", "unknown"] },
                error: { type: "string" },
                revertable: { type: "boolean" },
              },
              required: ["id", "status", "error", "revertable"],
              additionalProperties: false,
            },
          },
          failed: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, error: { type: "string" } },
              required: ["label", "error"],
              additionalProperties: false,
            },
          },
          audit: {
            type: "array",
            items: {
              type: "object",
              properties: {
                at: { type: "string" },
                action: { type: "string" },
                id: { type: "string" },
                hash: { type: "string" },
                files: { type: "array", items: { type: "string" } },
                via: { type: "string" },
                note: { type: "string" },
              },
              required: ["at", "action", "id", "hash", "files", "via", "note"],
              additionalProperties: false,
            },
          },
        },
        required: ["staged", "installed", "failed", "audit"],
        additionalProperties: false,
      },
    },
    diff: {
      input: one,
      output: {
        type: "object",
        properties: { text: { type: "string" }, hash: { type: "string" }, patch: { type: "string" } },
        required: ["text", "hash", "patch"],
        additionalProperties: false,
      },
    },
    approve: { input: bound, output: reply },
    reject: { input: one, output: reply },
    remove: { input: one, output: reply },
    revert: { input: one, output: reply },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, action: { type: "string" } },
        required: ["id", "action"],
        additionalProperties: false,
      },
    },
    /** The guard's reason, which opencode 2.3.2's permission dialog does not render. */
    warned: {
      schema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
})
