export function AppBrand({ shadowMode = import.meta.env.VITE_MUXPILOT_SHADOW === "1" }: { shadowMode?: boolean }) {
  return (
    <div className="brand">
      <img className="brand-logo" src="/favicon.svg" alt="" aria-hidden="true" />
      <strong>muxpilot</strong>
      {shadowMode ? <span className="shadow-badge">shadow</span> : null}
    </div>
  );
}
