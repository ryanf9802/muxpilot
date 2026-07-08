import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessQrScanner, accessKeyFromQrValue, accessKeyFromSearch, shouldOfferQrScanner } from "./Login.js";

describe("accessKeyFromSearch", () => {
  it("extracts the remote access key from QR URLs", () => {
    expect(accessKeyFromSearch("?accessKey=river-slate-42-orbit-copper-17")).toBe("river-slate-42-orbit-copper-17");
  });

  it("trims empty or padded access keys", () => {
    expect(accessKeyFromSearch("?accessKey=%20river-slate-42%20")).toBe("river-slate-42");
    expect(accessKeyFromSearch("?other=value")).toBe("");
  });
});

describe("accessKeyFromQrValue", () => {
  it("extracts access keys from absolute Connect device QR URLs", () => {
    expect(accessKeyFromQrValue("http://192.168.1.174:12778/access?accessKey=river-slate-42-orbit-copper-17")).toBe(
      "river-slate-42-orbit-copper-17"
    );
  });

  it("extracts access keys from relative Connect device QR URLs", () => {
    expect(accessKeyFromQrValue("/access?accessKey=%20river-slate-42%20")).toBe("river-slate-42");
  });

  it("rejects QR values without an access key", () => {
    expect(accessKeyFromQrValue("http://192.168.1.174:12778/")).toBe("");
    expect(accessKeyFromQrValue("not a url")).toBe("");
    expect(accessKeyFromQrValue("/access?other=value")).toBe("");
  });
});

describe("shouldOfferQrScanner", () => {
  it("requires browser camera APIs before the QR scanner is considered", () => {
    expect(shouldOfferQrScanner(undefined)).toBe(false);
    expect(shouldOfferQrScanner({ mediaDevices: undefined })).toBe(false);
  });
});

describe("AccessQrScanner", () => {
  it("renders the scan control when scanner availability has been confirmed", () => {
    const html = renderToStaticMarkup(
      createElement(AccessQrScanner, {
        open: false,
        submitting: false,
        onOpen: () => undefined,
        onCancel: () => undefined,
        onAccessKey: () => undefined
      })
    );

    expect(html).toContain("Scan QR code");
  });

  it("renders the camera panel when scanning is open", () => {
    const html = renderToStaticMarkup(
      createElement(AccessQrScanner, {
        open: true,
        submitting: false,
        onOpen: () => undefined,
        onCancel: () => undefined,
        onAccessKey: () => undefined
      })
    );

    expect(html).toContain("QR code scanner");
    expect(html).toContain("<video");
    expect(html).toContain("Cancel QR scan");
  });
});
