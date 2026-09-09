import { ClipboardList, MessageSquare, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import type {
  CodexModel,
  CodexModelCatalogResponse,
  CollaborationMode,
  ManagedSession,
  SessionModelSettings
} from "@muxpilot/core";
import { Modal } from "./Modal.js";

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
  session,
  catalog,
  loading,
  error,
  applying,
  onClose,
  onRetry,
  onApply
}: {
  open: boolean;
  session: ManagedSession;
  catalog: CodexModelCatalogResponse | null;
  loading: boolean;
  error: string;
  applying: boolean;
  onClose: () => void;
  onRetry: () => void;
  onApply: (mode: CollaborationMode, model: string, reasoningEffort: string | null) => Promise<boolean>;
}) {
  const mode = session.inputMode;
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const defaults = catalog?.defaults ?? emptyDefaults;
  const normal = effectiveModelSettings(session, defaults, "default");
  const plan = effectiveModelSettings(session, defaults, "plan");
  const current = mode === "plan" ? plan : normal;
  const selectedModel = catalog?.models.find((model) => model.model === draftModel) ?? null;

  useEffect(() => {
    if (!open || !catalog) return;
    const fallback = catalog.models.find((model) => model.isDefault) ?? catalog.models[0] ?? null;
    const model = catalog.models.find((candidate) => candidate.model === current.model) ?? fallback;
    setDraftModel(model?.model ?? "");
    setDraftEffort(validEffort(model, current.reasoningEffort));
  }, [catalog, current.model, current.reasoningEffort, mode, open]);

  const changed = draftModel !== current.model || draftEffort !== current.reasoningEffort;
  const valid = Boolean(selectedModel) && (
    selectedModel!.supportedReasoningEfforts.length === 0
      ? draftEffort === null
      : selectedModel!.supportedReasoningEfforts.some((option) => option.reasoningEffort === draftEffort)
  );
  const fastUnavailable = session.fastMode === true && selectedModel !== null && !supportsFast(selectedModel);
  const badgeSelections = useMemo(() => ({ normal, plan }), [normal.model, normal.reasoningEffort, plan.model, plan.reasoningEffort]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || !changed || applying) return;
    if (await onApply(mode, draftModel, draftEffort)) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Model settings · ${mode === "plan" ? "Plan" : "Normal"}`}
      panelClassName="model-settings-drawer"
      backdropClassName="model-settings-backdrop"
      closeLabel="Close model settings"
      placement="end"
      as="form"
      onSubmit={submit}
      dismissible={!applying}
      loading={loading || applying}
      initialFocusRef={initialFocusRef}
    >
      <div className="model-settings-intro">
        <p>Choose the model and reasoning effort used by the next {mode === "plan" ? "Plan" : "Normal"} turn.</p>
        <div className="model-settings-legend" aria-label="Option badge legend">
          <Badge icon={<Star />} label="Codex default" legend />
          <Badge icon={<MessageSquare />} label="Current Normal selection" legend />
          <Badge icon={<ClipboardList />} label="Current Plan selection" legend />
        </div>
      </div>
      <div className="model-settings-content">
        {loading && !catalog ? <p className="model-settings-state">Loading model options…</p> : null}
        {error ? (
          <div className="model-settings-state" role="alert">
            <p>{error}</p>
            {!catalog ? <button type="button" onClick={onRetry}>Retry</button> : null}
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
                    disabled={applying}
                    onChange={() => {
                      setDraftModel(model.model);
                      setDraftEffort(validEffort(model, model.model === current.model ? current.reasoningEffort : null));
                    }}
                  />
                  <span className="model-settings-option-copy">
                    <strong>{model.displayName}</strong>
                    <code>{model.model}</code>
                    {model.description ? <small>{model.description}</small> : null}
                  </span>
                  <span className="model-settings-badges">
                    {model.isDefault ? <Badge icon={<Star />} label="Codex default model" /> : null}
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
                      disabled={applying}
                      onChange={() => setDraftEffort(option.reasoningEffort)}
                    />
                    <span className="model-settings-option-copy">
                      <strong>{effortLabel(option.reasoningEffort)}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                    <span className="model-settings-badges">
                      {selectedModel.defaultReasoningEffort === option.reasoningEffort
                        ? <Badge icon={<Star />} label="Codex default reasoning effort" />
                        : null}
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
            {fastUnavailable ? <p className="model-settings-warning" role="note">Applying this model will turn off Fast mode.</p> : null}
          </>
        ) : null}
      </div>
      <div className="model-settings-actions">
        <button type="button" onClick={onClose} disabled={applying}>Cancel</button>
        <button className="primary" type="submit" disabled={!valid || !changed || applying} aria-busy={applying}>
          {applying ? "Applying" : "Apply"}
        </button>
      </div>
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
