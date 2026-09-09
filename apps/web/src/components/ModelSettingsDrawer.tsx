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
            <fieldset className="model-settings-options">
              <legend>Model</legend>
              {catalog.models.map((model, index) => (
                <label className="model-settings-option" key={model.id}>
                  <input
                    ref={index === 0 ? initialFocusRef : undefined}
                    type="radio"
                    name="codex-model"
                    value={model.model}
                    checked={draftModel === model.model}
                    disabled={Boolean(applying)}
                    onChange={() => {
                      setDraftModel(model.model);
                      const preferred = model.model === initial.model ? initial.reasoningEffort : null;
                      setDraftEffort(validEffort(model, preferred));
                    }}
                  />
                  <span className="model-settings-option-copy">
                    <strong>{model.displayName}</strong>
                    <code>{model.model}</code>
                    {model.description ? <small>{model.description}</small> : null}
                  </span>
                  <span className="model-settings-badges">
                    {badgeSelections.normal.model === model.model ? <Badge icon={<MessageSquare />} label="Current Normal model" /> : null}
                    {badgeSelections.plan.model === model.model ? <Badge icon={<ClipboardList />} label="Current Plan model" /> : null}
                  </span>
                </label>
              ))}
            </fieldset>
            {selectedModel && selectedModel.supportedReasoningEfforts.length > 0 ? (
              <fieldset className="model-settings-options">
                <legend>Reasoning effort</legend>
                {selectedModel.supportedReasoningEfforts.map((option) => (
                  <label className="model-settings-option" key={option.reasoningEffort}>
                    <input
                      type="radio"
                      name="codex-reasoning-effort"
                      value={option.reasoningEffort}
                      checked={draftEffort === option.reasoningEffort}
                      disabled={Boolean(applying)}
                      onChange={() => setDraftEffort(option.reasoningEffort)}
                    />
                    <span className="model-settings-option-copy">
                      <strong>{effortLabel(option.reasoningEffort)}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                    <span className="model-settings-badges">
                      {badgeSelections.normal.model === selectedModel.model && badgeSelections.normal.reasoningEffort === option.reasoningEffort
                        ? <Badge icon={<MessageSquare />} label="Current Normal reasoning effort" />
                        : null}
                      {badgeSelections.plan.model === selectedModel.model && badgeSelections.plan.reasoningEffort === option.reasoningEffort
                        ? <Badge icon={<ClipboardList />} label="Current Plan reasoning effort" />
                        : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
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
