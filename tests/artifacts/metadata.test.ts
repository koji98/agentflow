import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  artifactMetadataFields,
  contentTypeMismatch,
  detectArtifactContentType,
  encodingForContentType,
  inspectArtifactFile,
  mediaKindForContentType,
  normalizeContentType,
  type ArtifactFileMetadata
} from "../../src/artifacts/metadata.js";

async function writeTempFile(name: string, contents: Buffer | string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentflow-metadata-"));
  const filePath = join(root, name);
  await writeFile(filePath, contents);
  return filePath;
}

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gifBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function webpVp8xBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function jpegSofBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(11, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe("artifact metadata", () => {
  it("normalizes declared content types", () => {
    expect(normalizeContentType(" Text/Markdown; Charset=UTF-8 ")).toBe("text/markdown; charset=utf-8");
  });

  it("detects content types from magic bytes before extensions", () => {
    expect(detectArtifactContentType("report.txt", pngBuffer(3, 4))).toBe("image/png");
    expect(detectArtifactContentType("report.txt", jpegSofBuffer(5, 6))).toBe("image/jpeg");
    expect(detectArtifactContentType("report.txt", gifBuffer(7, 8))).toBe("image/gif");
    expect(detectArtifactContentType("report.txt", webpVp8xBuffer(9, 10))).toBe("image/webp");
    expect(detectArtifactContentType("report.txt", Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(detectArtifactContentType("report.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("application/zip");
    expect(detectArtifactContentType("report.txt", Buffer.from([0x1f, 0x8b, 0x08]))).toBe("application/gzip");
  });

  it("detects content types from extensions and text shape", () => {
    expect(detectArtifactContentType("notes.markdown", Buffer.from("ignored"))).toBe("text/markdown");
    expect(detectArtifactContentType("events.log", Buffer.from("ignored"))).toBe("text/plain");
    expect(detectArtifactContentType("rows.csv", Buffer.from("ignored"))).toBe("text/csv");
    expect(detectArtifactContentType("index.htm", Buffer.from("ignored"))).toBe("text/html");
    expect(detectArtifactContentType("diagram.svg", Buffer.from("ignored"))).toBe("image/svg+xml");
    expect(detectArtifactContentType("bundle.tar", Buffer.from("ignored"))).toBe("application/x-tar");
    expect(detectArtifactContentType("clip.mp4", Buffer.from("ignored"))).toBe("video/mp4");
    expect(detectArtifactContentType("clip.mov", Buffer.from("ignored"))).toBe("video/quicktime");
    expect(detectArtifactContentType("unknown", Buffer.from("  [1, 2, 3]\n"))).toBe("application/json");
    expect(detectArtifactContentType("unknown", Buffer.from(" <svg viewBox=\"0 0 1 1\"></svg>"))).toBe("image/svg+xml");
    expect(detectArtifactContentType("unknown", Buffer.from("plain text"))).toBe("text/plain");
    expect(detectArtifactContentType("unknown", Buffer.from([0x00, 0x01, 0x02]))).toBe("application/octet-stream");
  });

  it("classifies media kind and encoding from content type", () => {
    expect(mediaKindForContentType("text/markdown")).toBe("text");
    expect(mediaKindForContentType("application/json")).toBe("text");
    expect(mediaKindForContentType("image/svg+xml")).toBe("image");
    expect(mediaKindForContentType("image/png")).toBe("image");
    expect(mediaKindForContentType("application/pdf")).toBe("pdf");
    expect(mediaKindForContentType("application/zip")).toBe("archive");
    expect(mediaKindForContentType("application/gzip")).toBe("archive");
    expect(mediaKindForContentType("application/x-tar")).toBe("archive");
    expect(mediaKindForContentType("video/mp4")).toBe("video");
    expect(mediaKindForContentType("application/octet-stream")).toBe("binary");
    expect(encodingForContentType("text/plain")).toBe("utf-8");
    expect(encodingForContentType("application/json")).toBe("utf-8");
    expect(encodingForContentType("image/png")).toBe("binary");
  });

  it("inspects text and binary files with stable metadata", async () => {
    const textPath = await writeTempFile("notes.md", "alpha\nbeta\n");
    const textMetadata = await inspectArtifactFile(textPath, " TEXT/MARKDOWN ");

    expect(textMetadata).toMatchObject({
      content_type: "text/markdown",
      detected_content_type: "text/markdown",
      declared_content_type: "text/markdown",
      media_kind: "text",
      encoding: "utf-8",
      text: "alpha\nbeta\n",
      preview: {
        kind: "text",
        line_count: 3
      }
    });
    expect(textMetadata.size_bytes).toBe(Buffer.byteLength("alpha\nbeta\n"));
    expect(textMetadata.sha256).toBe(createHash("sha256").update("alpha\nbeta\n").digest("hex"));

    const pngPath = await writeTempFile("image.bin", pngBuffer(11, 13));
    const pngMetadata = await inspectArtifactFile(pngPath);
    expect(pngMetadata).toMatchObject({
      content_type: "image/png",
      detected_content_type: "image/png",
      media_kind: "image",
      encoding: "binary",
      preview: {
        kind: "image",
        width: 11,
        height: 13
      }
    });
    expect(pngMetadata.text).toBeUndefined();
  });

  it("builds previews for image and pdf artifacts", async () => {
    const jpeg = await inspectArtifactFile(await writeTempFile("photo.bin", jpegSofBuffer(31, 37)));
    expect(jpeg.preview).toEqual({ kind: "image", width: 31, height: 37 });

    const gif = await inspectArtifactFile(await writeTempFile("anim.bin", gifBuffer(17, 19)));
    expect(gif.preview).toEqual({ kind: "image", width: 17, height: 19 });

    const webp = await inspectArtifactFile(await writeTempFile("asset.bin", webpVp8xBuffer(23, 29)));
    expect(webp.preview).toEqual({ kind: "image", width: 23, height: 29 });

    const pdf = await inspectArtifactFile(
      await writeTempFile("doc.bin", "%PDF-1.7\n1 0 obj\n<< /Type /Page >>\n2 0 obj\n<< /Type /Page >>\n")
    );
    expect(pdf.preview).toEqual({ kind: "pdf", page_count: 2 });
  });

  it("reports declared content-type mismatches only when useful", () => {
    const baseMetadata: ArtifactFileMetadata = {
      content_type: "text/markdown",
      detected_content_type: "text/markdown",
      media_kind: "text",
      encoding: "utf-8",
      size_bytes: 12,
      sha256: "abc123",
      preview: { kind: "text", line_count: 1 }
    };

    expect(contentTypeMismatch(baseMetadata)).toBeUndefined();
    expect(contentTypeMismatch({ ...baseMetadata, declared_content_type: "text/markdown" })).toBeUndefined();
    expect(
      contentTypeMismatch({
        ...baseMetadata,
        declared_content_type: "application/json",
        detected_content_type: "application/octet-stream"
      })
    ).toBeUndefined();
    expect(contentTypeMismatch({ ...baseMetadata, declared_content_type: "application/json" })).toEqual({
      expected: "application/json",
      detected: "text/markdown"
    });
  });

  it("projects file metadata without retaining buffers or decoded text", async () => {
    const inspection = await inspectArtifactFile(await writeTempFile("artifact.json", "{\"ok\":true}\n"));

    expect(artifactMetadataFields(inspection)).toEqual({
      content_type: "application/json",
      detected_content_type: "application/json",
      media_kind: "text",
      encoding: "utf-8",
      size_bytes: inspection.size_bytes,
      sha256: inspection.sha256,
      preview: {
        kind: "text",
        line_count: 2
      }
    });
  });
});
