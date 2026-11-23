import { Rpc } from "@opencode/plugin/rpc"
import type { Snapshot } from "./kit.ts"

/** What the TUI receives. Mirrors `Snapshot`, which the server part returns. */
export type WireSnapshot = Snapshot
export type WireReply = { ok: boolean; message: string }
export type WireDiff = { text: string }

const one = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }
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
      output: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
    approve: { input: one, output: reply },
    reject: { input: one, output: reply },
    remove: { input: one, output: reply },
    revert: { input: one, output: reply },
  },
  events: {},
})
