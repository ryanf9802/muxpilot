import { FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, Lock, X } from "lucide-react";
import { api } from "../api/client.js";
import { installCtrlWGuard } from "../utils/ctrlW.js";
import { credentialSuppressedField } from "../utils/formFields.js";

interface QrScanResult {
  data: string;
}

interface QrScannerInstance {
  destroy: () => void;
  start: () => Promise<void>;
}

interface QrScannerClass {
  hasCamera: () => Promise<boolean>;
  new (
    video: HTMLVideoElement,
    onDecode: (result: QrScanResult) => void,
    options: {
      preferredCamera: "environment";
      returnDetailedScanResult: true;
      maxScansPerSecond: number;
      onDecodeError: () => void;
    }
  ): QrScannerInstance;
}

export function AccessPage() {
  const navigate = useNavigate();
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [scannerAvailable, setScannerAvailable] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  useEffect(() => installCtrlWGuard(), []);

  useEffect(() => {
    let cancelled = false;
    if (!shouldOfferQrScanner(navigator)) return;

    void loadQrScanner()
      .then((QrScanner) => QrScanner.hasCamera())
      .then((hasCamera) => {
        if (!cancelled) setScannerAvailable(hasCamera);
      })
      .catch(() => {
        if (!cancelled) setScannerAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const queryAccessKey = accessKeyFromSearch(window.location.search);
    if (queryAccessKey) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setAccessKey(queryAccessKey);
    }

    api
      .me()
      .then((me) => {
        if (me.accessGranted) {
          navigate("/", { replace: true });
          return;
        }
        if (queryAccessKey) {
          void submitAccessKey(queryAccessKey);
          return;
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await submitAccessKey(accessKey);
  }

  async function submitAccessKey(value: string) {
    if (submitting) return;
    setError("");
    setSubmitting(true);
    setScannerOpen(false);
    try {
      await api.access(value);
      navigate("/", { replace: true });
    } catch {
      setError("Invalid access key");
      setChecking(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) return <div className="center-screen">Checking access</div>;

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark">
          <Lock size={22} />
        </div>
        <h1>muxpilot</h1>
        <label>
          Access key
          <input
            {...credentialSuppressedField}
            value={accessKey}
            onChange={(event) => setAccessKey(event.target.value)}
            type="password"
            autoFocus
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button
          className="primary-button"
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          data-busy={submitting || undefined}
        >
          {submitting ? "Checking access" : "Continue"}
        </button>
        {scannerAvailable ? (
          <AccessQrScanner
            open={scannerOpen}
            submitting={submitting}
            onOpen={() => {
              setError("");
              setScannerOpen(true);
            }}
            onCancel={() => setScannerOpen(false)}
            onAccessKey={(value) => {
              setAccessKey(value);
              void submitAccessKey(value);
            }}
          />
        ) : null}
      </form>
    </div>
  );
}

export function accessKeyFromSearch(search: string): string {
  return new URLSearchParams(search).get("accessKey")?.trim() ?? "";
}

export function accessKeyFromQrValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const baseUrl = typeof window === "undefined" ? "http://muxpilot.test" : window.location.origin;
    const url = new URL(trimmed, baseUrl);
    return url.pathname === "/access" ? accessKeyFromSearch(url.search) : "";
  } catch {
    return "";
  }
}

export function shouldOfferQrScanner(navigatorLike: { mediaDevices?: { getUserMedia?: unknown } } | undefined): boolean {
  return typeof window !== "undefined" && Boolean(navigatorLike?.mediaDevices?.getUserMedia);
}

export function AccessQrScanner({
  open,
  submitting,
  onOpen,
  onCancel,
  onAccessKey
}: {
  open: boolean;
  submitting: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onAccessKey: (value: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScannerInstance | null>(null);
  const scannedRef = useRef(false);
  const [scannerError, setScannerError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    scannedRef.current = false;
    setScannerError("");
    setStarting(true);

    async function startScanner() {
      try {
        const QrScanner = await loadQrScanner();
        if (cancelled || !videoRef.current) return;

        const scanner = new QrScanner(
          videoRef.current,
          (result) => {
            if (scannedRef.current) return;
            const accessKey = accessKeyFromQrValue(result.data);
            if (!accessKey) {
              setScannerError("Scan the Connect device QR code.");
              return;
            }

            scannedRef.current = true;
            scanner.destroy();
            scannerRef.current = null;
            onAccessKey(accessKey);
          },
          {
            preferredCamera: "environment",
            returnDetailedScanResult: true,
            maxScansPerSecond: 8,
            onDecodeError: () => undefined
          }
        );
        scannerRef.current = scanner;
        await scanner.start();
        if (!cancelled) setStarting(false);
      } catch {
        if (!cancelled) {
          setScannerError("Camera access unavailable.");
          setStarting(false);
        }
      }
    }

    void startScanner();

    return () => {
      cancelled = true;
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, [onAccessKey, open]);

  if (!open) {
    return (
      <button className="secondary-button login-scan-button" type="button" disabled={submitting} onClick={onOpen}>
        <Camera size={17} />
        Scan QR code
      </button>
    );
  }

  return (
    <section className="login-scanner" aria-label="QR code scanner">
      <div className="login-scanner-head">
        <span>{starting ? "Starting camera" : "Scan QR code"}</span>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel QR scan" disabled={submitting}>
          <X size={16} />
        </button>
      </div>
      <video ref={videoRef} muted playsInline />
      {scannerError ? <p className="error">{scannerError}</p> : null}
    </section>
  );
}

async function loadQrScanner(): Promise<QrScannerClass> {
  const module = await import("qr-scanner");
  return module.default as unknown as QrScannerClass;
}
