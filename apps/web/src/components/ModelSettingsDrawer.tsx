import { ClipboardList, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  CodexModel,
  CodexModelCatalogResponse,
  CollaborationMode,
  ManagedSession,
  SessionModelSelections,
  SessionModelSettings
} from "@muxpilot/core";
import { Modal } from "./Modal.js";
import { Button, DialogActions } from "./Button.js";
import {
  comparisonGuidance,
  comparisonGuidanceSource,
  publishedModelGuidance,
  type ComparisonLevel
} from "./modelComparisonGuidance.js";

export function effectiveModelSettings(
  session: Pick<ManagedSession, "models">,
  defaults: CodexModelCatalogResponse["defaults"],
  mode: CollaborationMode
): SessionModelSettings {
  const saved = session.models[mode];
  return {
    model: saved.model ?? defaults[mode].model,
    reasoningEffort: saved.model ? saved.reasoningEffort : defaults[mode].reasoningEffort
  };
}

export function ModelSettingsDrawer({
  open,
  title,
  description,
  selections,
  activeMode,
  fastMode,
  catalog,
  loading,
  error,
  applying,
  onClose,
  onRetry,
  onApply
}: {
  open: boolean;
  title: string;
  description: string;
  selections: SessionModelSelections;
  activeMode: CollaborationMode | null;
  fastMode?: boolean | null;
  catalog: CodexModelCatalogResponse | null;
  loading: boolean;
  error: string;
  applying: CollaborationMode | null;
  onClose: () => void;
  onRetry: () => void;
  onApply: (mode: CollaborationMode, model: string, reasoningEffort: string | null) => Promise<void>;
}) {
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const defaults = catalog?.defaults ?? emptyDefaults;
  const normal = effectiveModelSettings({ models: selections }, defaults, "default");
  const plan = effectiveModelSettings({ models: selections }, defaults, "plan");
  const initialMode = activeMode ?? "default";
  const initial = initialMode === "plan" ? plan : normal;
  const selectedModel = catalog?.models.find((model) => model.model === draftModel) ?? null;

  useEffect(() => {
    if (!open || !catalog) return;
    const fallback = catalog.models.find((model) => model.isDefault) ?? catalog.models[0] ?? null;
    const model = catalog.models.find((candidate) => candidate.model === initial.model) ?? fallback;
    setDraftModel(model?.model ?? "");
    setDraftEffort(validEffort(model, initial.reasoningEffort));
  }, [catalog, initial.model, initial.reasoningEffort, initialMode, open]);

  const changedNormal = draftModel !== normal.model || draftEffort !== normal.reasoningEffort;
  const changedPlan = draftModel !== plan.model || draftEffort !== plan.reasoningEffort;
  const valid = Boolean(selectedModel) && (
    selectedModel!.supportedReasoningEfforts.length === 0
      ? draftEffort === null
      : selectedModel!.supportedReasoningEfforts.some((option) => option.reasoningEffort === draftEffort)
  );
  const fastUnavailable = fastMode === true && selectedModel !== null && !supportsFast(selectedModel);
  const activeSelectionChanged = activeMode === "plan" ? changedPlan : activeMode === "default" ? changedNormal : false;
  const badgeSelections = useMemo(() => ({ normal, plan }), [normal.model, normal.reasoningEffort, plan.model, plan.reasoningEffort]);

  async function apply(mode: CollaborationMode) {
    if (!valid || applying) return;
    await onApply(mode, draftModel, draftEffort);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      panelClassName="model-settings-drawer"
      backdropClassName="model-settings-backdrop"
      closeLabel="Close model settings"
      placement="end"
      dismissible={!applying}
      loading={loading || Boolean(applying)}
      initialFocusRef={initialFocusRef}
    >
      <div className="model-settings-intro">
        <p>{description}</p>
        <div className="model-settings-legend" aria-label="Option badge legend">
          <Badge icon={<MessageSquare />} label="Current Normal selection" legend />
          <Badge icon={<ClipboardList />} label="Current Plan selection" legend />
        </div>
      </div>
      <div className="model-settings-content">
        {loading && !catalog ? <p className="model-settings-state">Loading model options…</p> : null}
        {error ? (
          <div className="model-settings-state" role="alert">
            <p>{error}</p>
            <Button size="small" onClick={onRetry} disabled={Boolean(applying)}>Retry</Button>
          </div>
        ) : null}
        {catalog && catalog.models.length === 0 ? <p className="model-settings-state">No Codex models are currently available.</p> : null}
        {catalog && catalog.models.length > 0 ? (
          <>
            <div className="model-settings-comparison-note" role="note">
              <strong>Compare each combination</strong>
              <span>Estimated quality is for coding and agent work. Estimated usage is relative subscription allowance consumption.</span>
              {fastMode === true ? <span className="model-settings-fast-usage">Fast mode is on and increases usage for supported models; the bars do not apply an unsupported multiplier.</span> : null}
            </div>
            <fieldset className="model-settings-options model-settings-combinations">
              <legend>Model and reasoning</legend>
              {catalog.models.map((model) => {
                const efforts = model.supportedReasoningEfforts.length > 0
                  ? model.supportedReasoningEfforts
                  : [{ reasoningEffort: null, description: "This model does not expose a reasoning setting." }];
                return (
                  <section className="model-settings-model" key={model.id} aria-labelledby={`model-${model.id}`}>
                    <div className="model-settings-model-head">
                      <span className="model-settings-option-copy">
                        <strong id={`model-${model.id}`}>{model.displayName}</strong>
                        <code>{model.model}</code>
                        {model.description ? <small>{model.description}</small> : null}
                      </span>
                    </div>
                    <div className="model-settings-efforts">
                      {efforts.map((option, optionIndex) => {
                        const effort = option.reasoningEffort;
                        const estimate = comparisonGuidance(model.model, effort);
                        const selected = draftModel === model.model && draftEffort === effort;
                        return (
                          <label className="model-settings-option model-settings-combination" key={effort ?? "none"}>
                            <input
                              ref={model === catalog.models[0] && optionIndex === 0 ? initialFocusRef : undefined}
                              type="radio"
                              name="codex-model-combination"
                              value={`${model.model}:${effort ?? "none"}`}
                              checked={selected}
                              disabled={Boolean(applying)}
                              onChange={() => {
                                setDraftModel(model.model);
                                setDraftEffort(effort);
                              }}
                            />
                            <span className="model-settings-combination-copy">
                              <span className="model-settings-combination-title">
                                <strong>{effort ? effortLabel(effort) : "Standard"}</strong>
                                <span className="model-settings-badges">
                                  {badgeSelections.normal.model === model.model && badgeSelections.normal.reasoningEffort === effort
                                    ? <Badge icon={<MessageSquare />} label="Current Normal combination" />
                                    : null}
                                  {badgeSelections.plan.model === model.model && badgeSelections.plan.reasoningEffort === effort
                                    ? <Badge icon={<ClipboardList />} label="Current Plan combination" />
                                    : null}
                                </span>
                              </span>
                              {option.description ? <small>{option.description}</small> : null}
                              {estimate ? (
                                <>
                                  <ComparisonMeter kind="quality" label="Estimated quality" level={estimate.quality} levelLabel={estimate.qualityLabel} />
                                  <ComparisonMeter kind="usage" label="Estimated usage" level={estimate.usage} levelLabel={estimate.usageLabel} />
                                  <small className="model-settings-estimate-summary">{estimate.summary}</small>
                                </>
                              ) : (
                                <span className="model-settings-unrated">Quality and usage: Not yet rated</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </fieldset>
            <PublishedGuidance models={catalog.models.map((model) => model.model)} fastMode={fastMode === true} />
            {fastUnavailable && activeMode && activeSelectionChanged ? <p className="model-settings-warning" role="note">Applying this model to the active {activeMode === "plan" ? "Plan" : "Normal"} mode will turn off Fast mode.</p> : null}
          </>
        ) : null}
      </div>
      <DialogActions className="model-settings-actions">
        <Button variant="ghost" onClick={onClose} disabled={Boolean(applying)}>Cancel</Button>
        <Button
          variant="primary"
          icon={<MessageSquare size={16} />}
          disabled={!valid || !changedNormal || Boolean(applying)}
          busy={applying === "default"}
          busyLabel="Applying Normal"
          onClick={() => void apply("default")}
        >
          Apply Normal
        </Button>
        <Button
          variant="primary"
          icon={<ClipboardList size={16} />}
          disabled={!valid || !changedPlan || Boolean(applying)}
          busy={applying === "plan"}
          busyLabel="Applying Plan"
          onClick={() => void apply("plan")}
        >
          Apply Plan
        </Button>
      </DialogActions>
    </Modal>
  );
}

function ComparisonMeter({ kind, label, level, levelLabel }: {
  kind: "quality" | "usage";
  label: string;
  level: ComparisonLevel;
  levelLabel: string;
}) {
  return (
    <span className={`model-settings-meter model-settings-meter-${kind}`} aria-label={`${label}: ${levelLabel}, ${level} of 5`}>
      <span className="model-settings-meter-label">{label}</span>
      <span className="model-settings-meter-track" aria-hidden="true">
        {([1, 2, 3, 4, 5] as const).map((band) => <i className={band <= level ? "is-filled" : ""} key={band} />)}
      </span>
      <span className="model-settings-meter-value">{levelLabel}</span>
    </span>
  );
}

function PublishedGuidance({ models, fastMode }: { models: string[]; fastMode: boolean }) {
  const available = models.flatMap((model) => {
    const published = publishedModelGuidance[model];
    return published ? [{ model, ...published }] : [];
  });
  return (
    <details className="model-settings-evidence">
      <summary>About these estimates and published usage</summary>
      <p>These combination ratings are curated guidance, reviewed {formatGuidanceDate(comparisonGuidanceSource.reviewedAt)}. Actual usage varies with context, task complexity, reasoning, tools, retrieval, and caching.</p>
      {fastMode ? <p>Fast mode is reflected by the visible usage notice above.</p> : null}
      {available.length > 0 ? (
        <dl>
          {available.map((item) => (
            <div key={item.model}>
              <dt>{item.model}</dt>
              <dd>{item.allowance}. Credit rates: {item.credits}.</dd>
            </div>
          ))}
        </dl>
      ) : <p>No published model-level usage information is available for the listed models.</p>}
      <a href={comparisonGuidanceSource.url} target="_blank" rel="noreferrer">OpenAI pricing and allowance guidance</a>
    </details>
  );
}

function formatGuidanceDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function Badge({ icon, label, legend = false }: { icon: ReactElement; label: string; legend?: boolean }) {
  return (
    <span className={`model-settings-badge${legend ? " model-settings-badge-legend" : ""}`} role="img" title={label} aria-label={label}>
      {icon}
      {legend ? <span>{label}</span> : null}
    </span>
  );
}

function validEffort(model: CodexModel | null | undefined, preferred: string | null): string | null {
  if (!model || model.supportedReasoningEfforts.length === 0) return null;
  if (preferred && model.supportedReasoningEfforts.some((option) => option.reasoningEffort === preferred)) return preferred;
  if (model.defaultReasoningEffort && model.supportedReasoningEfforts.some((option) => option.reasoningEffort === model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return model.supportedReasoningEfforts[0]?.reasoningEffort ?? null;
}

function effortLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function supportsFast(model: CodexModel): boolean {
  return model.serviceTiers.some((tier) => tier.id.toLowerCase() === "fast" || tier.id.toLowerCase() === "priority");
}

const emptyDefaults: CodexModelCatalogResponse["defaults"] = {
  default: { model: null, reasoningEffort: null },
  plan: { model: null, reasoningEffort: null }
};
