import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AGENT_PROVIDER_KINDS,
  providerLoginCommand,
  type AgentProviderKind,
  type AgentSkillsResponse,
  type MuxpilotGitSkillStatus,
  type ProviderDescriptor,
  type ProvidersResponse
} from "@muxpilot/core";
import type { AccessControl } from "../auth/auth.js";
import type { AppDatabase } from "../db/database.js";
import { ProviderRegistry, UnknownProviderError } from "../providers/registry.js";
import { ProviderAuthUnavailableError } from "../providers/shared/authLifecycle.js";
import type { AgentProvider } from "../providers/types.js";
import { ModelSettingsError, type SessionManager } from "../services/sessionManager.js";

const providerParamsSchema = z.object({ kind: z.enum(AGENT_PROVIDER_KINDS) });
const collaborationModeSchema = z.enum(["default", "plan"]);
const modelSettingsSchema = z.object({
  mode: collaborationModeSchema,
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(100).nullable()
});
const approvalReviewerSettingsSchema = z.object({
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(100).nullable()
});
const resetCreditSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  creditId: z.string().trim().min(1).max(200).nullable().optional()
}).strict();

export interface ProviderRouteDependencies {
  manager: SessionManager;
  providers: ProviderRegistry;
  db: Pick<AppDatabase, "setDefaultAgentProvider">;
  access: AccessControl;
}

export function providerDescriptor(provider: AgentProvider): ProviderDescriptor {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    enabled: true,
    compatibility: provider.compatibility(),
    capabilities: provider.capabilities,
    auth: provider.auth.state(),
    skillInvocation: provider.skillInvocation,
    loginCommand: providerLoginCommand(provider.kind)
  };
}

/** Provider catalog, authentication, usage, model, reviewer and skill endpoints. */
export function registerProviderRoutes(app: FastifyInstance, dependencies: ProviderRouteDependencies): void {
  const { manager, providers, db, access } = dependencies;
  const guard = { preHandler: access.requireAccess };

  app.get("/api/providers", guard, async (): Promise<ProvidersResponse> => ({
    defaultProvider: providers.defaultProvider(),
    providers: providers.list().map(providerDescriptor)
  }));

  app.patch("/api/providers/default", guard, async (request, reply) => {
    const { provider } = z.object({ provider: z.enum(AGENT_PROVIDER_KINDS) }).strict().parse(request.body);
    return withProviderErrors(reply, async () => {
      providers.setDefaultProvider(provider);
      await db.setDefaultAgentProvider(provider, new Date().toISOString());
      return {
        defaultProvider: providers.defaultProvider(),
        providers: providers.list().map(providerDescriptor)
      } satisfies ProvidersResponse;
    });
  });

  app.get("/api/providers/:kind/auth", guard, async (request, reply) =>
    withProvider(request.params, reply, (provider) => provider.auth.state())
  );

  app.post("/api/providers/:kind/auth/refresh", guard, async (request, reply) =>
    withProvider(request.params, reply, (provider) => provider.auth.refresh())
  );

  app.get("/api/providers/:kind/usage/summary", guard, async (request, reply) => {
    const { refresh } = z.object({ refresh: z.enum(["0", "1"]).optional() }).parse(request.query);
    return withProvider(request.params, reply, (provider) => provider.usage.summary(refresh === "1"));
  });

  app.get("/api/providers/:kind/usage/history", guard, async (request, reply) => {
    const parsed = z.object({
      days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30)])).default(30),
      refresh: z.enum(["0", "1"]).optional()
    }).parse(request.query);
    return withProvider(request.params, reply, (provider) => {
      if (!provider.usage.tokenUsage) throw new UnknownProviderError(`${provider.displayName} does not report token history`);
      return provider.usage.tokenUsage(parsed.days, parsed.refresh === "1");
    });
  });

  app.post("/api/providers/:kind/usage/reset", guard, async (request, reply) => {
    const body = resetCreditSchema.parse(request.body);
    return withProvider(request.params, reply, (provider) => {
      if (!provider.usage.consumeResetCredit) throw new UnknownProviderError(`${provider.displayName} has no usage reset tokens`);
      return provider.usage.consumeResetCredit(body.idempotencyKey, body.creditId);
    });
  });

  app.get("/api/providers/:kind/models", guard, async (request, reply) =>
    withProvider(request.params, reply, (provider) => manager.modelCatalog(provider.kind))
  );

  app.get("/api/providers/:kind/model-settings/defaults", guard, async (request, reply) =>
    withProvider(request.params, reply, async (provider) => ({ settings: await manager.globalModelSettings(provider.kind) }))
  );

  app.patch("/api/providers/:kind/model-settings/defaults", guard, async (request, reply) => {
    const body = modelSettingsSchema.parse(request.body);
    return withProvider(request.params, reply, async (provider) => ({
      settings: await manager.updateGlobalModelSettings(provider.kind, body.mode, body.model, body.reasoningEffort)
    }));
  });

  app.get("/api/providers/:kind/approval-reviewer/settings", guard, async (request, reply) =>
    withProvider(request.params, reply, async (provider) => ({ settings: await manager.approvalReviewerSettings(provider.kind) }))
  );

  app.patch("/api/providers/:kind/approval-reviewer/settings", guard, async (request, reply) => {
    const body = approvalReviewerSettingsSchema.parse(request.body);
    return withProvider(request.params, reply, async (provider) => ({
      settings: await manager.updateApprovalReviewerSettings(provider.kind, body.model, body.reasoningEffort)
    }));
  });

  app.get("/api/providers/:kind/skills", guard, async (request, reply) =>
    withProvider(request.params, reply, async (provider): Promise<AgentSkillsResponse> => ({ skills: await provider.skills.discover([]) }))
  );

  app.get("/api/providers/:kind/skills/muxpilot-git-workflow/status", guard, async (request, reply) =>
    withProvider(request.params, reply, (provider): Promise<MuxpilotGitSkillStatus> => provider.skills.gitWorkflowSkillStatus())
  );

  async function withProvider<T>(
    params: unknown,
    reply: FastifyReply,
    operation: (provider: AgentProvider) => T | Promise<T>
  ): Promise<T | void> {
    const parsed = providerParamsSchema.safeParse(params);
    if (!parsed.success) {
      await reply.code(404).send({ error: "Unknown provider" });
      return;
    }
    return withProviderErrors(reply, () => operation(providers.get(parsed.data.kind as AgentProviderKind)));
  }
}

async function withProviderErrors<T>(reply: FastifyReply, operation: () => T | Promise<T>): Promise<T | void> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UnknownProviderError) {
      await reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    if (error instanceof ProviderAuthUnavailableError || error instanceof ModelSettingsError) {
      await reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    throw error;
  }
}
