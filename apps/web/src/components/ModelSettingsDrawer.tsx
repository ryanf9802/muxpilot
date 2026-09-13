import { ClipboardList, MessageSquare, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  CodexModel,
  CodexModelCatalogResponse,
  CollaborationMode,
  ApprovalMode,
  ApprovalReviewerSettings,
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
  reviewerSettings,
  approvalMode,
  approvalModeInheritedFrom,
  approvalModeApplying = false,
  approvalModeError = "",
  onClose,
  onRetry,
  onApply,
  onApplyReviewer,
  onApprovalModeChange
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
  applying: CollaborationMode | "reviewer" | null;
  reviewerSettings?: ApprovalReviewerSettings | null;
  approvalMode?: ApprovalMode;
  approvalModeInheritedFrom?: { id: string; name: string } | null;
  approvalModeApplying?: boolean;
  approvalModeError?: string;
  onClose: () => void;
  onRetry: () => void;
  onApply: (mode: CollaborationMode, model: string, reasoningEffort: string | null) => Promise<void>;
  onApplyReviewer?: (model: string, reasoningEffort: string | null) => Promise<void>;
  onApprovalModeChange?: (mode: ApprovalMode) => Promise<void>;
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
  const changedReviewer = reviewerSettings !== undefined && reviewerSettings !== null
    && (draftModel !== reviewerSettings.model || draftEffort !== reviewerSettings.reasoningEffort);
  const valid = Boolean(selectedModel) && (
    selectedModel!.supportedReasoningEfforts.length === 0
      ? draftEffort === null
      : selectedModel!.supportedReasoningEfforts.some((option) => option.reasoningEffort === draftEffort)
  );
  const fastUnavailable = fastMode === true && selectedModel !== null && !supportsFast(selectedModel);
  const activeSelectionChanged = activeMode === "plan" ? changedPlan : activeMode === "default" ? changedNormal : false;
  const badgeSelections = useMemo(() => ({ normal, plan }), [normal.model, normal.reasoningEffort, plan.model, plan.reasoningEffort]);

  const busy = Boolean(applying) || approvalModeApplying;

  async function apply(mode: CollaborationMode | "reviewer") {
    if (!valid || applying) return;
    if (mode === "reviewer") await onApplyReviewer?.(draftModel, draftEffort);
    else await onApply(mode, draftModel, draftEffort);
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
      dismissible={!busy}
      loading={loading || busy}
      initialFocusRef={initialFocusRef}
    >
      <div className="model-settings-intro">
        <p>{description}</p>
        <div className="model-settings-legend" aria-label="Option badge legend">
          <Badge icon={<MessageSquare />} label="Current Normal selection" legend />
          <Badge icon={<ClipboardList />} label="Current Plan selection" legend />
          {reviewerSettings ? <Badge icon={<ShieldCheck />} label="Current Auto reviewer selection" legend /> : null}
        </div>
      </div>
      <div className="model-settings-content">
        {loading && !catalog ? <p className="model-settings-state">Loading model options…</p> : null}
        {error ? (
          <div className="model-settings-state" role="alert">
            <p>{error}</p>
            <Button size="small" onClick={onRetry} disabled={busy}>Retry</Button>
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
                    disabled={busy}
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
                    {reviewerSettings?.model === model.model ? <Badge icon={<ShieldCheck />} label="Current Auto reviewer model" /> : null}
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
                      disabled={busy}
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
                      {reviewerSettings?.model === selectedModel.model && reviewerSettings.reasoningEffort === option.reasoningEffort
                        ? <Badge icon={<ShieldCheck />} label="Current Auto reviewer reasoning effort" />
                        : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {fastUnavailable && activeMode && activeSelectionChanged ? <p className="model-settings-warning" role="note">Applying this model to the active {activeMode === "plan" ? "Plan" : "Normal"} mode will turn off Fast mode.</p> : null}
          </>
        ) : null}
        {approvalMode && onApprovalModeChange ? (
          <fieldset className="model-settings-options model-settings-permissions">
            <legend>Permissions</legend>
            <label>
              <span>
                <strong>Session approval mode</strong>
                <small>{approvalModeInheritedFrom
                  ? <>Inherited from <a href={`/sessions/${approvalModeInheritedFrom.id}`}>{approvalModeInheritedFrom.name}</a>.</>
                  : "Controls how runtime permission requests are resolved for this session."}</small>
              </span>
              <select
                value={approvalMode}
                disabled={busy || Boolean(approvalModeInheritedFrom)}
                aria-invalid={Boolean(approvalModeError) || undefined}
                aria-label="Session permissions"
                onChange={(event) => void onApprovalModeChange(event.currentTarget.value as ApprovalMode)}
              >
                <option value="ask">Ask for approval</option>
                <option value="auto">Auto approval</option>
                <option value="full">Full approval</option>
              </select>
            </label>
            {approvalModeError ? <p className="model-settings-warning" role="alert">{approvalModeError}</p> : null}
          </fieldset>
        ) : null}
      </div>
      <DialogActions className="model-settings-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="primary"
          icon={<MessageSquare size={16} />}
          disabled={!valid || !changedNormal || busy}
          busy={applying === "default"}
          busyLabel="Applying Normal"
          onClick={() => void apply("default")}
        >
          Apply Normal
        </Button>
        <Button
          variant="primary"
          icon={<ClipboardList size={16} />}
          disabled={!valid || !changedPlan || busy}
          busy={applying === "plan"}
          busyLabel="Applying Plan"
          onClick={() => void apply("plan")}
        >
          Apply Plan
        </Button>
        {reviewerSettings && onApplyReviewer ? (
          <Button
            variant="primary"
            icon={<ShieldCheck size={16} />}
            disabled={!valid || !changedReviewer || busy}
            busy={applying === "reviewer"}
            busyLabel="Applying Reviewer"
            onClick={() => void apply("reviewer")}
          >
            Apply Reviewer
          </Button>
        ) : null}
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
