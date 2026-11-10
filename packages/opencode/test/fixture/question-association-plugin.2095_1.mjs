import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const readOpenCodeQuestionAssociation = function readOpenCodeQuestionAssociation(input, metadata) {
  const args = input !== null && typeof input === "object" ? input : {}, meta = metadata !== null && typeof metadata === "object" ? metadata : {}, candidates = [];
  if ("questionRequestAssociation" in meta) {
    const value = meta.questionRequestAssociation;
    if (value === null || typeof value !== "object" || !("purpose" in value) || !("sourceId" in value) || !["request", "scope-selection"].includes(String(value.purpose)) || (value.purpose === "request" ? typeof value.sourceId !== "string" || value.sourceId.length === 0 : value.sourceId !== null))
      throw Object.assign(Error("The native question request association is invalid."), { code: "corrupt" });
    candidates.push(value);
  }
  if ("stratcraftRequirementRequestSourceId" in args || "stratcraftRequirementQuestionPurpose" in args)
    candidates.push({ purpose: args.stratcraftRequirementQuestionPurpose, sourceId: args.stratcraftRequirementRequestSourceId });
  if ("requirementRequestSourceId" in meta || "requirementQuestionPurpose" in meta)
    candidates.push({ purpose: meta.requirementQuestionPurpose, sourceId: meta.requirementRequestSourceId });
  if (candidates.length === 0)
    return;
  const purposes = candidates.flatMap((value) => value.purpose === void 0 ? [] : [value.purpose]), sources = candidates.flatMap((value) => value.sourceId === void 0 ? [] : [value.sourceId]);
  if (new Set(purposes).size > 1)
    throw Object.assign(Error("The continuation question purpose changed."), { code: "conflict" });
  if (new Set(sources).size > 1)
    throw Object.assign(Error("The continuation question request association changed."), { code: "conflict" });
  const purpose = purposes[0] ?? null, sourceId = sources[0] ?? null;
  if (purpose !== null && !["request", "scope-selection", "unavailable"].includes(String(purpose)) || sourceId !== null && typeof sourceId !== "string")
    throw Object.assign(Error("The native question request association is invalid."), { code: "corrupt" });
  if (purpose === "scope-selection" && sourceId !== null)
    throw Object.assign(Error("Scope selection cannot establish requirement answer attribution."), { code: "conflict" });
  return { purpose, sourceId: sourceId === "" ? null : sourceId };
};

const HEADER = "X-StratCraft-OpenCode-Request";
const CONTINUE_COMMAND = "continue";
const CONTINUE_TEMPLATE = "Continue the unfinished requirements of the current bound Strategy Project from the fresh authoritative continuation. Follow its next action, preserve resolved choices and required reviews, and stop if all work is complete. This control action adds no new requirement.";
const CONTINUATION_REFUSAL_MESSAGES = {"unavailable":"The bound session is not ready for continuation. Refresh its connection and try again.","busy":"The current authoring interaction is already in progress. Wait for it to finish before continuing.","closed":"The authoring session ended. Open its existing task to review the next action."};
function refuseContinuation(code) {
  throw Object.assign(new Error(CONTINUATION_REFUSAL_MESSAGES[code]), {
    name: "StratCraftContinuationRefused", code,
  });
}
const MANAGED_PROVIDER_IDS = new Set([
  "stratcraft-openai",
  "stratcraft-claude",
  "stratcraft-deepseek",
  "stratcraft-gemini",
]);
const DOMAIN = "stratcraft-opencode-request-namespace";
const VERSION = "1";
const TRACE_MAX_ITEMS = 128;
const TRACE_MAX_ID_LENGTH = 256;
const traceId = value => typeof value === "string" && value.length <= TRACE_MAX_ID_LENGTH
  && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
const textDigest = value => typeof value === "string" ? createHash("sha256").update(value).digest("hex") : null;
let lastPartIdTimestamp = 0;
let partIdCounter = 0;

function frame(value) {
  const body = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function requestNamespace(sessionID, messageID) {
  if (typeof sessionID !== "string" || !sessionID
    || typeof messageID !== "string" || !messageID) {
    throw new Error("OpenCode request namespace requires string session and message identities.");
  }
  return createHash("sha256")
    .update(Buffer.concat([frame(DOMAIN), frame(VERSION), frame(sessionID), frame(messageID)]))
    .digest("base64url");
}

function partId() {
  const timestamp = Date.now();
  if (timestamp !== lastPartIdTimestamp) {
    lastPartIdTimestamp = timestamp;
    partIdCounter = 0;
  }
  partIdCounter += 1;
  const time = (BigInt(timestamp) * 0x1000n + BigInt(partIdCounter))
    .toString(16).padStart(12, "0").slice(-12);
  return "prt_" + time + randomBytes(7).toString("hex");
}

export const StratCraftIdempotency = async (_input, options = {}) => {
  const orientationUrl = options.orientationUrl;
  const admissionUrl = options.admissionUrl;
  const sourceCaptureUrl = options.sourceCaptureUrl;
  const leaseTokenEnvironmentVariable = options.leaseTokenEnvironmentVariable;
  const taskSkillRoot = options.taskSkillRoot;
  const orientations = new Map();
  const historyReconciliations = new Map();
  const inspectionTools = new Map();
  const deferredQuestionCaptures = new Map();
  const preparedContexts = new Map();
  const continuationSubmissions = new Map();
  let traceWarningEmitted = false;

  // Native logging keeps diagnostics in the existing local OpenCode log.
  // These are preparation receipts, not proof that a provider received a request.
  async function trace(stage, fields) {
    if (typeof _input?.client?.app?.log !== "function") return;
    try {
      const result = await _input.client.app.log({ body: {
        service: "stratcraft-authoring-context", level: "info",
        message: JSON.stringify({ schemaVersion: 1, stage, atUtc: new Date().toISOString(), ...fields }),
      } });
      if (result?.error) throw new Error("Trace storage failed.");
    } catch {
      if (!traceWarningEmitted) {
        traceWarningEmitted = true;
        process.emitWarning("OpenCode authoring context trace is unavailable; request delivery is not evidenced by this trace.",
          { code: "STRATCRAFT_CONTEXT_TRACE_UNAVAILABLE" });
      }
    }
  }

  function contextTrace(input, orientation, contextId) {
    const continuation = orientation?.continuation;
    const pending = Array.isArray(continuation?.pendingChanges) ? continuation.pendingChanges : [];
    return {
      contextId, sessionId: traceId(input.sessionID), providerId: traceId(input.model?.providerID), modelId: traceId(input.model?.id),
      projectId: traceId(continuation?.binding?.projectId), taskId: traceId(continuation?.binding?.taskId),
      workspaceId: traceId(continuation?.binding?.workspaceId), snapshotToken: traceId(continuation?.snapshotToken),
      pendingCount: Number.isSafeInteger(continuation?.summary?.pendingCount) ? continuation.summary.pendingCount : null,
      nextAction: traceId(continuation?.nextAction?.kind),
      completionSatisfied: typeof continuation?.completion?.satisfied === "boolean" ? continuation.completion.satisfied : null,
      pendingChangesCount: pending.length, pendingChangesTruncated: pending.length > TRACE_MAX_ITEMS,
      pendingChanges: pending.slice(0, TRACE_MAX_ITEMS).map(item => ({
        id: traceId(item.id), textSha256: textDigest(item.text), review: traceId(item.review?.state),
        sourceIds: (Array.isArray(item.sources) ? item.sources : []).slice(0, TRACE_MAX_ITEMS).map(source => traceId(source.sourceId)),
        sourcesTruncated: Array.isArray(item.sources) && item.sources.length > TRACE_MAX_ITEMS,
      })),
    };
  }

  async function admit() {
    if (admissionUrl === undefined) return;
    const token = process.env[leaseTokenEnvironmentVariable];
    if (typeof admissionUrl !== "string" || !admissionUrl || !token) {
      throw new Error("The current authoring admission is unavailable.");
    }
    const response = await fetch(admissionUrl, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json();
    if (!response.ok || payload?.admitted !== true) {
      throw Object.assign(new Error(typeof payload?.error === "string" ? payload.error
        : "The private authoring entitlement is unavailable. Refresh authorization and reopen the project."),
        { code: payload?.code });
    }
  }

  async function captureSources(input, output) {
    if (typeof input.sessionID !== "string" || !input.sessionID
      || typeof output?.message?.id !== "string" || !output.message.id
      || typeof sourceCaptureUrl !== "string" || !sourceCaptureUrl
      || typeof leaseTokenEnvironmentVariable !== "string" || !leaseTokenEnvironmentVariable) {
      throw new Error("Requirement source capture failed before inference.");
    }
    const token = process.env[leaseTokenEnvironmentVariable];
    if (!token) throw new Error("Requirement source capture failed before inference.");
    const textParts = output.parts.filter((part) => part?.type === "text"
      && part.synthetic !== true && part.ignored !== true && typeof part.text === "string" && part.text.length > 0);
    if (textParts.length === 0) return;
    let sourceIds;
    try {
      sourceIds = await Promise.all(textParts.map(async (part, index) => {
        const sourceId = "OCSRC-" + createHash("sha256")
          .update(Buffer.concat([
            frame("stratcraft-opencode-requirement-source"),
            frame(input.sessionID),
            frame(output.message.id),
            frame(typeof part.id === "string" && part.id ? part.id : String(index)),
          ]))
          .digest("hex");
        const response = await fetch(sourceCaptureUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sourceId,
            sourceText: part.text,
            submittedAtUtc: new Date(output.message.time?.created ?? Date.now()).toISOString(),
            submittedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
            sessionId: input.sessionID,
            messageId: output.message.id,
          }),
        });
        const payload = await response.json();
        if (response.ok && payload?.ignored === true) return null;
        if (!response.ok || typeof payload?.sourceId !== "string" || !payload.sourceId)
          throw Object.assign(new Error("Requirement source capture failed before inference."), { code: payload?.code });
        return payload.sourceId;
      }));
    } catch (error) {
      historyReconciliations.delete(input.sessionID);
      throw Object.assign(new Error("Requirement source capture failed before inference."), { code: error?.code });
    }
    sourceIds = sourceIds.filter(id => id !== null);
    if (sourceIds.length === 0) return;
    output.parts.push({
      id: partId(),
      sessionID: input.sessionID,
      messageID: output.message.id,
      type: "text",
      synthetic: true,
      text: "Authoritative requirement source IDs for this user message: " + JSON.stringify(sourceIds),
    });
  }

  async function reconcileHistory(sessionID, token) {
    const deferred = deferredQuestionCaptures.get(sessionID);
    if (deferred) {
      for (const [callID, messageID] of deferred) {
        const message = await _input.client.session.message({ path: { id: sessionID, messageID } });
        const question = message.data?.parts?.find(part => part.type === "tool" && part.callID === callID);
        if (question?.state?.status !== "completed" || !Array.isArray(question.state.metadata?.questions)
          || !Array.isArray(question.state.metadata?.answers)) {
          throw new Error("The selected answer is awaiting durable native completion before dependent operations.");
        }
      }
    }
    let pending = historyReconciliations.get(sessionID);
    if (!pending) {
      pending = fetch(orientationUrl.slice(0, -"orientation".length) + "reconcile-history", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ nativeSessionId: sessionID }),
      }).then(async response => {
        if (!response.ok) {
          const failure = await response.json();
          if (["AUTHORING_MCP_LEASE_UNKNOWN", "AUTHORING_MCP_LEASE_EXPIRED",
            "AUTHORING_MCP_REGISTRY_CLOSED"].includes(failure?.code)) refuseContinuation("closed");
          throw Object.assign(new Error("The owned historical requirement reconciliation failed."), { code: failure?.code });
        }
      }).catch(error => {
        historyReconciliations.delete(sessionID);
        throw error;
      });
      historyReconciliations.set(sessionID, pending);
    }
    await pending;
    if (deferredQuestionCaptures.get(sessionID) === deferred) deferredQuestionCaptures.delete(sessionID);
  }

  async function orient(sessionID) {
    if (typeof sessionID !== "string" || !sessionID) {
      throw new Error("Strategy Authoring orientation requires an OpenCode session identity.");
    }
    if (typeof orientationUrl !== "string" || !orientationUrl
      || typeof leaseTokenEnvironmentVariable !== "string" || !leaseTokenEnvironmentVariable) {
      throw new Error("Strategy Authoring orientation bootstrap is not configured.");
    }
    const token = process.env[leaseTokenEnvironmentVariable];
    if (!token) throw new Error("The task-scoped Strategy Authoring lease is unavailable.");
    let pending = orientations.get(sessionID);
    if (!pending) {
      pending = reconcileHistory(sessionID, token).then(() => fetch(orientationUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ nativeSessionId: sessionID }),
      })).catch((error) => {
        if (error?.name === "StratCraftContinuationRefused") throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(`The Strategy Authoring orientation endpoint is unavailable: ${detail}`), { code: error?.code });
      }).then(async (response) => {
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error(
            `The Strategy Authoring orientation endpoint returned invalid JSON (HTTP ${response.status}).`,
          );
        }
        if (!response.ok) {
          const message = typeof payload?.error === "string" && payload.error
            ? payload.error
            : "Strategy Authoring orientation failed.";
          const code = typeof payload?.code === "string" && payload.code ? payload.code : null;
          if (["AUTHORING_MCP_SESSION_UNAVAILABLE", "AUTHORING_MCP_SESSION_MISMATCH",
            "AUTHORING_MCP_SESSION_INVALID"].includes(code)) refuseContinuation("unavailable");
          if (["AUTHORING_MCP_LEASE_UNKNOWN", "AUTHORING_MCP_LEASE_EXPIRED",
            "AUTHORING_MCP_REGISTRY_CLOSED"].includes(code)) refuseContinuation("closed");
          throw new Error(code ? `[${code}] ${message}` : message);
        }
        inspectionTools.set(sessionID, new Set((payload.capabilityAvailability?.capabilities ?? [])
          .filter(entry => entry.capability.endsWith(".inspect"))
          .flatMap(entry => entry.toolNames.map(name => "stratforge_" + name))));
        return payload;
      });
      orientations.set(sessionID, pending);
      pending.catch(() => orientations.delete(sessionID));
    }
    // Share concurrent reads only. Each later inference boundary revalidates
    // task scope, pending changes and admission against authoritative state.
    try { return await pending; }
    finally { if (orientations.get(sessionID) === pending) orientations.delete(sessionID); }
  }

  return {
  event: async ({ event }) => {
    if (["question.asked", "permission.asked", "session.status"].includes(event?.type)) {
      const sessionID = event.properties?.sessionID;
      if (typeof sessionID === "string" && sessionID) {
        // A pending request is published after native registration. Observe it
        // through the same protected owner even when inference is suspended.
        const previous = orientations.get(sessionID);
        if (previous) await previous;
        await orient(sessionID);
      }
      return;
    }
    if (event?.type === "session.idle") {
      for (const [key, group] of preparedContexts) {
        if (group.sessionId === event.properties?.sessionID) preparedContexts.delete(key);
      }
    }
    const info = event?.type === "message.updated" ? event.properties?.info : null;
    if (info?.role !== "assistant" || !info.time?.completed) return;
    await trace("assistant_finished", { sessionId: traceId(info.sessionID), messageId: traceId(info.id),
      parentMessageId: traceId(info.parentID), finish: traceId(info.finish) });
  },
  "chat.message": captureSources,
  "command.execute.before": async (input, output) => {
    if (input.command !== CONTINUE_COMMAND) return;
    if (input.arguments.trim()) throw new Error("The continuation command does not accept arguments.");
    if (!input.messageID) throw new Error("The native continuation command lifecycle is unavailable.");
    if (continuationSubmissions.has(input.sessionID)) refuseContinuation("busy");
    continuationSubmissions.set(input.sessionID, input.messageID);
    try {
      const orientation = await orient(input.sessionID);
      const continuation = orientation?.continuation;
      if (continuation?.binding?.nativeSessionId !== input.sessionID) refuseContinuation("unavailable");
      const control = continuation.continuationControl;
      if (!control || !["ready", "complete"].includes(control.state)) {
        refuseContinuation(["busy", "closed"].includes(control?.state) ? control.state : "unavailable");
      }
      const status = await _input.client.session.status();
      if (status.error || !status.data) refuseContinuation("unavailable");
      if (status.data[input.sessionID] && status.data[input.sessionID].type !== "idle") {
        refuseContinuation("busy");
      }
      // Managed configuration must own this name; do not execute a colliding template.
      if (output.parts.length !== 1 || output.parts[0]?.type !== "text" || output.parts[0].text !== CONTINUE_TEMPLATE) {
        throw new Error("The managed continuation command conflicts with another command definition.");
      }
      // Retain the fresh owner projection in this synthetic intake as well as
      // the system hook, so restored command history carries its actual action.
      const { questionCatalog, ...context } = orientation;
      output.parts[0].text += "\n" + JSON.stringify(context);
      output.parts[0].synthetic = true;
    } catch (error) {
      continuationSubmissions.delete(input.sessionID);
      throw error;
    }
  },
  "command.execute.after": async input => {
    if (input.command === CONTINUE_COMMAND && continuationSubmissions.get(input.sessionID) === input.messageID) {
      continuationSubmissions.delete(input.sessionID);
    }
  },
  "tool.execute.after": async (input, output) => {
    if (input.tool === "bash" && process.env["STRATCRAFT_AUTHORING_PYTHON_RUNTIME"]) {
      output.metadata = { ...output.metadata, managedPythonRuntime: JSON.parse(process.env["STRATCRAFT_AUTHORING_PYTHON_RUNTIME"]) };
    }
    if (input.tool !== "question" || !Array.isArray(output.metadata?.questions)
      || !Array.isArray(output.metadata?.answers) || output.metadata.questions.length === 0) return;
    const assistant = await _input.client.session.message({ path: { id: input.sessionID, messageID: input.messageID } });
    const nativeQuestion = assistant.data?.parts?.find(part => part.type === "tool" && part.callID === input.callID);
    const answeredAt = assistant.data?.info?.time?.created ?? nativeQuestion?.state?.time?.start;
    if (!Number.isSafeInteger(answeredAt) || answeredAt < 0) throw new Error("The answer native timestamp is unavailable.");
    const parentID = assistant.data?.info?.parentID;
    if (!parentID) throw new Error("The answer has no owning request.");
    const request = await _input.client.session.message({ path: { id: input.sessionID, messageID: parentID } });
    const part = request.data?.parts?.find(part => part.type === "text" && part.synthetic !== true && part.ignored !== true);
    const control = request.data?.parts?.some(part => part.type === "text" && part.synthetic === true);
    let requestSourceId;
    if (control && !part) {
      const storedState = nativeQuestion?.state;
      const issuedAssociation = readOpenCodeQuestionAssociation(storedState?.input, storedState?.metadata);
      const completedAssociation = readOpenCodeQuestionAssociation(undefined, output.metadata);
      const association = issuedAssociation ?? completedAssociation;
      if (issuedAssociation && completedAssociation && ((issuedAssociation.purpose !== null
        && completedAssociation.purpose !== null && issuedAssociation.purpose !== completedAssociation.purpose)
        || issuedAssociation.sourceId !== completedAssociation.sourceId)) throw new Error("The continuation question request association changed.");
      output.metadata.requirementQuestionPurpose = association?.purpose ?? "unavailable";
      if (association?.purpose === "scope-selection") {
        output.metadata.requirementRequestSourceId = null;
        output.output += "\nScope selection is retained in this native question. Continue resolving the selected request through the authoritative continuation before requirement-specific clarification or review.";
        return;
      }
      requestSourceId = association?.sourceId ?? null;
      output.metadata.requirementRequestSourceId = requestSourceId ?? null;
      if (!requestSourceId) {
        output.output += "\nThe selected answer is retained, but its exact original request association is unresolved. "
          + "Resolve the exact request through the bound continuation before dependent operations.";
        return;
      }
    } else {
      if (!part?.id) throw new Error("The answer request source is unavailable.");
      requestSourceId = "OCSRC-" + createHash("sha256").update(Buffer.concat([
        frame("stratcraft-opencode-requirement-source"), frame(input.sessionID), frame(parentID), frame(part.id),
      ])).digest("hex");
    }
    const sourceId = "OCANSWER-" + createHash("sha256").update(Buffer.concat([
      frame(input.sessionID), frame(input.callID),
    ])).digest("hex");
    const requirementAnswers = output.metadata.questions.flatMap((question, index) => {
      const values = output.metadata.answers[index];
      if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== "string")) return [];
      return [{ requestSourceId,
        questionId: question.questionId || input.callID + ":" + index,
        questionText: question.question || question.header || "",
        value: values.join("\n"),
        answerKind: values.every(value => question.options?.some(option => option.optionId === value || option.label === value))
          ? "choice" : "free-text" }];
    });
    if (requirementAnswers.length === 0) return;
    const dispositionIndex = output.metadata.questions.findIndex(question => question.questionId === "algorithm-disposition");
    const dispositionQuestion = output.metadata.questions[dispositionIndex];
    const dispositionAnswers = output.metadata.answers[dispositionIndex];
    const dispositionValue = Array.isArray(dispositionAnswers) && dispositionAnswers.length === 1 ? dispositionAnswers[0] : null;
    const option = dispositionQuestion?.options?.find(option => option.optionId === dispositionValue || option.label === dispositionValue);
    const token = process.env[leaseTokenEnvironmentVariable];
    try {
      const response = await fetch(sourceCaptureUrl, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, sourceText: requirementAnswers.map(answer => answer.value).join("\n"),
          sessionId: input.sessionID, messageId: input.messageID,
          submittedAtUtc: new Date(answeredAt).toISOString(),
          submittedTimezone: "Etc/UTC", requirementAnswers,
          ...(dispositionValue === null ? {} : { algorithmDisposition: { questionId: "algorithm-disposition", requestSourceId,
            optionId: option?.optionId ?? null, answerKind: option ? "choice" : "free-text" } }) }),
      });
      const captured = await response.json();
      if (response.ok && captured?.ignored === true) return;
      if (!response.ok || captured?.sourceId !== sourceId)
        throw Object.assign(new Error("Answer source capture failed."), { code: captured?.code });
    } catch (error) {
      historyReconciliations.delete(input.sessionID);
      // A lease refusal is authoritative; only observation failures use deferred recovery.
      if (typeof error?.code === "string" && error.code.startsWith("AUTHORING_MCP_")) throw error;
      let deferred = deferredQuestionCaptures.get(input.sessionID);
      if (!deferred) { deferred = new Map(); deferredQuestionCaptures.set(input.sessionID, deferred); }
      deferred.set(input.callID, input.messageID);
      output.output += "\nThe selected answer source capture is pending. Keep this native question result; authoritative recovery is required before dependent operations.";
      return;
    }
    const deferred = deferredQuestionCaptures.get(input.sessionID);
    deferred?.delete(input.callID);
    if (deferred?.size === 0) deferredQuestionCaptures.delete(input.sessionID);
    output.metadata.requirementRequestSourceId = requestSourceId;
    output.metadata.requirementAnswerSourceId = sourceId;
    output.output += "\nAuthoritative " + (dispositionValue === null ? "answer" : "disposition") + " source ID: " + sourceId + "; request source ID: " + requestSourceId;
    if (dispositionValue !== null) output.output += option ? "; selected option: " + option.optionId
      : "; interpret this typed answer against the same pending disposition question before preparing its exact native review.";

  },
  "shell.env": async (_input, output) => {
    const bin = process.env["STRATCRAFT_AUTHORING_PYTHON_BIN"];
    if (!bin) return;
    output.env.PATH = bin + (process.platform === "win32" ? ";" : ":") + (process.env.PATH || "");
    output.env.PYTHONHOME = "";
    output.env.PYTHONPATH = "";
    output.env.PYTHONUSERBASE = "";
    output.env.PYTHONNOUSERSITE = "1";
  },
  "tool.execute.before": async (input, output) => {
    const independentInspection = ["read", "glob", "grep", "list", "skill", "webfetch", "websearch", "codesearch", "todoread"].includes(input.tool)
      || inspectionTools.get(input.sessionID)?.has(input.tool);
    if (!independentInspection && deferredQuestionCaptures.has(input.sessionID)) {
      await reconcileHistory(input.sessionID, process.env[leaseTokenEnvironmentVariable]);
    }
    if (input.tool === "question" && input.messageID) {
      // Catalog args stay immutable; only native-created context carries trusted association.
      if (output.questionContext) delete output.questionContext.requestAssociation;
      const assistant = await _input.client.session.message({ path: { id: input.sessionID, messageID: input.messageID } });
      const parentID = assistant.data?.info?.parentID;
      if (parentID) {
        const request = await _input.client.session.message({ path: { id: input.sessionID, messageID: parentID } });
        if (request.data?.parts?.some(part => part.type === "text" && part.synthetic === true)
          && !request.data.parts.some(part => part.type === "text" && part.synthetic !== true && part.ignored !== true)) {
          const orientation = await orient(input.sessionID);
          const continuation = orientation?.continuation;
          const association = continuation?.binding?.nativeSessionId === input.sessionID ? continuation.clarificationRequest : null;
          if (!association || !["request", "scope-selection"].includes(association.purpose)
            || (association.purpose === "request" && (typeof association.sourceId !== "string" || !association.sourceId))) {
            throw new Error(association?.reason || "The clarification original request observation is unavailable.");
          }
          if (!output.questionContext) throw new Error("The native question execution context is unavailable.");
          output.questionContext.requestAssociation = { purpose: association.purpose, sourceId: association.sourceId ?? null };
        }
      }
    }
    // Read tools retain native workspace permissions; effects use their owning endpoint.
    if (!["write", "edit", "apply_patch", "multiedit", "bash"].includes(input.tool)) return;
    const token = process.env[leaseTokenEnvironmentVariable];
    const response = await fetch(orientationUrl.slice(0, -"orientation".length) + "execution-check", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ nativeSessionId: input.sessionID, tool: input.tool }),
    });
    const result = await response.json();
    if (!response.ok || result?.admitted !== true) throw Object.assign(new Error(typeof result?.error === "string"
      ? result.error : "The native authoring tool is not admitted."), { code: result?.code });
  },
  "chat.headers": async (input, output) => {
    // Bounded tasks admit inference at the resource endpoint; other tasks use this check.
    await admit();
    const contextKey = JSON.stringify([input.sessionID, input.model?.providerID, input.model?.id]);
    const group = preparedContexts.get(contextKey);
    await trace("request_prepared", { sessionId: traceId(input.sessionID), messageId: traceId(input.message?.id),
      providerId: traceId(input.model?.providerID), modelId: traceId(input.model?.id),
      contextId: group && !group.ambiguous ? group.ids[0] : null,
      contextAssociation: !group ? "unavailable" : group.ambiguous ? "ambiguous" : "exact",
      candidateContextIds: group?.ids ?? [], candidateContextsTruncated: group?.truncated ?? false });
    if (group && --group.remaining === 0 && preparedContexts.get(contextKey) === group) preparedContexts.delete(contextKey);
    if (!MANAGED_PROVIDER_IDS.has(input.model.providerID)) return;
    if (Object.keys(output.headers).some((name) => name.toLowerCase() === HEADER.toLowerCase())) {
      throw new Error("conflicting StratCraft OpenCode request header");
    }
    output.headers[HEADER] = requestNamespace(input.sessionID, input.message.id);
  },
  "experimental.chat.system.transform": async (input, output) => {
    const orientation = await orient(input.sessionID);
    const { questionCatalog, ...modelOrientation } = orientation;
    const current = orientation.nativeBinding;
    if (current?.taskId === null) {
      const root = fs.realpathSync(current.taskProjectionPath);
      const workspace = fs.realpathSync(current.workingDirectory);
      const relativeRoot = path.relative(workspace, root);
      if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot))
        throw new Error("The current continuation instructions are outside the owned workspace.");
      const readInstruction = filename => {
        const resolved = fs.realpathSync(filename);
        const relative = path.relative(root, resolved);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
          || !fs.lstatSync(resolved).isFile()) throw new Error("The continuation instruction file is not owned.");
        return fs.readFileSync(resolved, "utf8");
      };
      const relativeFiles = ["AGENTS.md", path.relative(root, current.domainInstructionPath),
        ...[".agents/skills/stratcraft-intent-scope-and-workspace-safety/SKILL.md",".agents/skills/stratcraft-brainstorming-and-design/SKILL.md",".agents/skills/stratcraft-systematic-debugging/SKILL.md",".agents/skills/stratcraft-verification-and-completion/SKILL.md",".agents/skills/ask-matt/SKILL.md",".agents/skills/code-review/SKILL.md",".agents/skills/codebase-design/SKILL.md",".agents/skills/diagnosing-bugs/SKILL.md",".agents/skills/domain-modeling/SKILL.md",".agents/skills/grill-with-docs/SKILL.md",".agents/skills/implement/SKILL.md",".agents/skills/implement-spec/SKILL.md",".agents/skills/improve-codebase-architecture/SKILL.md",".agents/skills/pr/SKILL.md",".agents/skills/prototype/SKILL.md",".agents/skills/research/SKILL.md",".agents/skills/retro/SKILL.md",".agents/skills/setup-matt-pocock-skills/SKILL.md",".agents/skills/tdd/SKILL.md",".agents/skills/to-spec/SKILL.md",".agents/skills/to-tickets/SKILL.md",".agents/skills/triage/SKILL.md",".agents/skills/wayfinder/SKILL.md",".agents/skills/wizard/SKILL.md",".agents/skills/chief-of-staff/SKILL.md",".agents/skills/claude-handoff/SKILL.md",".agents/skills/loop-me/SKILL.md",".agents/skills/setup-ts-deep-modules/SKILL.md",".agents/skills/writing-beats/SKILL.md",".agents/skills/writing-fragments/SKILL.md",".agents/skills/writing-shape/SKILL.md",".agents/skills/git-guardrails-claude-code/SKILL.md",".agents/skills/migrate-to-shoehorn/SKILL.md",".agents/skills/scaffold-exercises/SKILL.md",".agents/skills/setup-pre-commit/SKILL.md",".agents/skills/grill-me/SKILL.md",".agents/skills/grilling/SKILL.md",".agents/skills/handoff/SKILL.md",".agents/skills/teach/SKILL.md",".agents/skills/to-questionnaire/SKILL.md",".agents/skills/wait-what/SKILL.md",".agents/skills/writing-for-agents/SKILL.md"]];
      const currentInstructions = relativeFiles.map(relative => {
        const content = readInstruction(path.join(root, relative));
        // Replace launch-time material in the native system context as well.
        if (typeof taskSkillRoot === "string" && taskSkillRoot) {
          const previous = path.join(path.dirname(path.dirname(taskSkillRoot)), relative);
          if (fs.existsSync(previous)) {
            const old = fs.readFileSync(previous, "utf8");
            if (old) output.system = output.system.map(text => text.split(old).join(content));
          }
        }
        return content;
      });
      const missing = currentInstructions.filter(content => !output.system.some(text => text.includes(content)));
      if (missing.length) output.system.push(missing.join("\n\n"));
    }
    const actor = orientation.nativeActor;
    const rootSessionId = actor?.rootNativeSessionId ?? input.sessionID;
    if (actor && actor.nativeSessionId !== input.sessionID) throw new Error("The native authoring actor does not match.");
    const delegated = actor && actor.nativeSessionId !== rootSessionId;
    const continuation = orientation.continuation;
    if (continuation?.schemaVersion === 1 && continuation.binding?.taskId) {
      if (continuation.binding.nativeSessionId !== rootSessionId || !continuation.binding.taskSpecHash) {
        throw new Error("The authoritative instruction delivery session does not match.");
      }
      const token = process.env[leaseTokenEnvironmentVariable];
      const identity = continuation.instructionIdentity;
      if (!identity || identity.taskSpecHash !== continuation.binding.taskSpecHash
        || identity.nativeSessionId !== rootSessionId || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) {
        throw new Error("The authoritative instruction delivery identity is unavailable or conflicting.");
      }
      // Delegated delivery records the actual child actor; a root receipt cannot replace it.
      if (delegated || identity.acknowledged !== true) {
        const receipt = await fetch(orientationUrl.slice(0, -"orientation".length) + "delivery", {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ nativeSessionId: input.sessionID, taskSpecHash: continuation.binding.taskSpecHash,
            instructionFingerprint: identity.fingerprint }),
        });
        const result = await receipt.json();
        if (!receipt.ok || result?.acknowledged !== true) {
          throw new Error(typeof result?.error === "string" ? result.error : "The bound instruction delivery acknowledgement failed.");
        }
        const delivered = result.continuation;
        if (delivered?.instructionIdentity?.fingerprint !== identity.fingerprint
          || delivered?.binding?.taskId !== continuation.binding.taskId
          || delivered.binding.taskSpecHash !== continuation.binding.taskSpecHash
          || delivered.binding.nativeSessionId !== rootSessionId) {
          throw new Error("The acknowledged authoring continuation does not match the delivered instructions.");
        }
        modelOrientation.continuation = delivered;
      }
    }
    const context = contextTrace(input, modelOrientation, randomBytes(16).toString("hex"));
    await trace("orientation_read", context);
    output.system.push(
      (delegated
        ? "You are a delegated authoring session. Preserve your actual actor identity and the owning root in the supplied context. Execute only the parent's bounded assignment and existing reviewed execution scope. Requirement intake, review/application, execution claims, task handoff and final requirement completion belong to the root. Return evidence to the parent; do not treat this delegation prompt as a user requirement.\n"
        : "")
      + (typeof taskSkillRoot === "string" && taskSkillRoot
        ? "Task-local Skills are under " + (current?.taskId === null
          ? path.join(current.taskProjectionPath, ".agents", "skills") : taskSkillRoot) + ". "
          + "Pass the exact absolute reference path returned by a native Skill result to Read. "
          + "Resolve a Skill's relative reference from the directory containing its SKILL.md.\n"
        : "")
        + "Authoritative Strategy Authoring fresh-context orientation. Keep the complete result as current internal context. Present only the project state, constraints, and next decision relevant to the user; preserve complete disclosures in the authoritative review flow:\n"
        + (delegated
          ? (actor.readOnly
            ? "Do not edit source. Perform only the bounded inspection using native-admitted tools and the existing reviewed scope. "
            : "Edit only within the parent's bounded assignment and reviewed scope; requirement execution registration is not an edit permission. ")
            + "Inspect relevant existing source and tests within the assignment, preserve the same algorithm, and return subordinate verification evidence and unresolved blockers. Do not perform requirement intake, review, withdrawal, task handoff or final requirement completion. Native tool permissions and existing execution checks remain authoritative.\n"
          : "Ordinary Strategy Authoring validation and edit/test/repair continuation have no validation-attempt count limit. Historical maxRepairIterations values and older instructions about validation counts or repair iterations are obsolete and must not stop ordinary authorized retests. Preserve cancellation, operation admission, actual resource and model-cost controls, and exact source/test evidence. Continue repairs from actual diagnostics within the authorized scope. When validationRepair is present, consume its candidate-bound diagnostic codes and locations together with the retained failing tool results. Repair the cause and validate the changed candidate again; preserve meaningful assertions and reassess repeated failures. A denied optional inspection does not block independent authorized repairs. Report a genuinely required unavailable capability through the existing incomplete outcome without bypassing access controls. Separately reviewed Backtest research-search and Mining Adapter allowances remain effective. Resolve a generic request to continue unfinished work from the fresh shared continuation before entering the code-inspection or verification workflow. When observation.state is complete, summary.pendingCount is 0, nextAction.kind is no_runnable, and completion.satisfied is true with empty outstandingIds and blockers, report that no unfinished requirements remain and end this response. Do not automatically inspect source/tests, claim an execution group, trace or validate the candidate, or delegate more work for that request. This status report is not a new candidate-verification claim: the fresh continuation is its evidence, so the verification Skill's fresh-command rule does not require another candidate validation. Unknown current-session verification and unsaved or unaccepted draft state do not reopen completed implementation. Explicit requests for revalidation or code review, new or amended requirements, failed-work recovery, and separately reviewed save/acceptance retain their existing workflows and authorization. An empty runnable set alone is not completion; preserve pending changes, blockers and incomplete observation. If a tool refuses an operation, follow the fresh continuation instead of trying to claim completed requirements.\n"
        + "Bounded implementation work is registered internally at the native work boundary. Only when multiple executable requirement groups need substantive selection, use begin_strategy_authoring_requirement_execution with item_ids for the chosen frozen revisions. Workspace, snapshot, task hash and idempotency are resolved internally. Progress registration is independent of edit permission; repair authorized code and tests in the same session. Preserve pending source IDs for semantic interpretation, clarify or amend existing targets before native prepare/apply review, and do not treat captured messages as atomic accepted requirements. When the user requests withdrawal of an eligible pending item, invoke withdraw_strategy_authoring_requirement_change with its exact item ID as change_id. The native lease supplies workspace and session identity; omit Guide conversation_id and session_id. An unreviewed captured message is withdrawn directly. Only when the result has reviewRequired=true, invoke prepare_strategy_authoring_requirement_review with the returned withdrawal changeId as withdrawal_change_id and the returned continuation snapshotToken; preserve its canonical rejected status and fingerprint, then use the existing native apply review and reviewed task rebase. Do not pass the original addition ID as withdrawal_change_id or claim withdrawal succeeded after a failed tool result. Never reinterpret a withdrawal as an accepted proposal. Preserve active resolved choices. In Agent mode resolve remaining task-scoped choices internally, invoke apply_strategy_authoring_requirement_review with the saved review_id, and continue the returned task through coding and tests without waiting for user approval. Preparation is not application. On continuation reuse a valid current saved review; if stale, prepare from current authoritative sources and requirements. Inspect task and ledger outcomes before any repeat application. Manual mode asks only unresolved material fields. Before a final completion response use its completion.satisfied, outstandingIds and blockers; an empty runnable set or completed code group does not complete all requested scope. Keep verification evidence and acceptance distinct, and retain valid partial evidence when later additions remain pending.\n"
        )
        + JSON.stringify(modelOrientation)
        + (delegated ? "" : "\nApply algorithmState before intake: when it is authored-draft or accepted, present the current-state summary, inspect the relevant existing source and tests before code-specific guidance or edits, continue the same algorithm by default, and do not use the starting-path catalog unless the user explicitly asks to explore a different algorithm. When it is empty or starter-template, use the admitted starting-path catalog."),
    );
    await trace("system_context_prepared", { ...context, contextSha256: textDigest(output.system.at(-1)) });
    // Hooks expose no inference-call identity. Preserve ambiguity for overlapping
    // title/build requests instead of assigning the most recently observed context.
    const contextKey = JSON.stringify([input.sessionID, input.model?.providerID, input.model?.id]);
    const group = preparedContexts.get(contextKey);
    if (group) {
      group.remaining += 1;
      group.ambiguous = true;
      if (group.ids.length < TRACE_MAX_ITEMS) group.ids.push(context.contextId);
      else group.truncated = true;
    } else preparedContexts.set(contextKey, { sessionId: input.sessionID, ids: [context.contextId], remaining: 1, ambiguous: false, truncated: false });
  },
  };
};
