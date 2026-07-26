import {
  detectPhotoFormat,
  formatCapturedAt,
  readEncodedSize,
  readPhotoMetadata,
  validateDecodedSize,
  type ExifReaderAdapter,
} from "./photo";

function binaryFile(bytes: readonly number[], type = "application/octet-stream"): File {
  return new File([Uint8Array.from(bytes)], "photo.bin", { type });
}

describe("detectPhotoFormat", () => {
  it("recognizes JPEG and PNG from magic bytes instead of MIME", async () => {
    const jpeg = binaryFile([0xff, 0xd8, 0xff, 0xe1, 0x00], "image/png");
    const png = binaryFile([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ], "image/jpeg");

    await expect(detectPhotoFormat(jpeg)).resolves.toBe("image/jpeg");
    await expect(detectPhotoFormat(png)).resolves.toBe("image/png");
  });

  it("reads only the eight-byte header and rejects other content", async () => {
    const file = binaryFile([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0]);
    const slice = vi.spyOn(file, "slice");

    await expect(detectPhotoFormat(file)).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
      message: "The file is not a supported JPEG or PNG image.",
    });
    expect(slice).toHaveBeenCalledWith(0, 8);
  });
});

describe("readEncodedSize", () => {
  it("reads PNG dimensions before browser decode", async () => {
    const png = binaryFile([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x27, 0x10, 0x00, 0x00, 0x27, 0x10,
    ]);

    const size = await readEncodedSize(png, "image/png");
    expect(size).toEqual({ width: 10_000, height: 10_000 });
    expect(() => validateDecodedSize(size ?? { width: 0, height: 0 })).toThrowError(
      expect.objectContaining({ code: "DECODED_IMAGE_TOO_LARGE" }),
    );
  });

  it("skips JPEG metadata segments and reads the start-of-frame dimensions", async () => {
    const jpeg = binaryFile([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x06, 0xaa, 0xbb, 0xcc, 0xdd,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x12, 0x34, 0x56, 0x78,
    ]);

    await expect(readEncodedSize(jpeg, "image/jpeg")).resolves.toEqual({
      width: 0x5678,
      height: 0x1234,
    });
  });

  it("rejects malformed JPEG marker boundaries without scanning the payload byte by byte", async () => {
    const jpeg = binaryFile([
      0xff, 0xd8, 0xff, 0x00,
      ...new Array<number>(20_000).fill(0x41),
    ]);
    const slice = vi.spyOn(jpeg, "slice");

    await expect(readEncodedSize(jpeg, "image/jpeg")).resolves.toBeNull();
    expect(slice.mock.calls.length).toBeLessThan(10);
  });
});

describe("formatCapturedAt", () => {
  it("uses hyphens for the date while preserving time colons", () => {
    expect(formatCapturedAt("2026:07:26 21:15:00")).toBe("2026-07-26 21:15:00");
    expect(formatCapturedAt("already formatted")).toBe("already formatted");
    expect(formatCapturedAt(null)).toBeNull();
  });
});

describe("readPhotoMetadata", () => {
  it("adapts only the allowed display metadata", async () => {
    const load = vi.fn<ExifReaderAdapter["load"]>().mockResolvedValue({
      Orientation: { value: 6, description: "Rotate 90 CW" },
      DateTimeOriginal: { value: ["2026:07:26 21:15:00"], description: "2026:07:26 21:15:00" },
      Make: { value: ["Sony"], description: "Sony" },
      Model: { value: ["ILCE-7M4"], description: "ILCE-7M4" },
      ISOSpeedRatings: { value: 640, description: "640" },
      ExposureTime: { value: [1, 125], computed: 1 / 125, description: "1/125" },
      FNumber: { value: [8, 1], computed: 8, description: "f/8" },
      FocalLength: { value: [400, 1], computed: 400, description: "400 mm" },
      GPSLatitude: { value: "must-not-be-read" },
    });
    const adapter: ExifReaderAdapter = { load };

    await expect(readPhotoMetadata(binaryFile([0xff]), adapter)).resolves.toEqual({
      orientation: 6,
      capturedAt: "2026:07:26 21:15:00",
      camera: "Sony ILCE-7M4",
      iso: 640,
      exposureTime: 1 / 125,
      fNumber: 8,
      focalLength: 400,
    });
    const options = load.mock.calls[0]?.[1];
    expect(options?.includeTags.exif).not.toContain("GPSLatitude");
    expect(options?.includeTags.exif).toContain("Orientation");
  });

  it("returns stable null fields when metadata is missing or malformed", async () => {
    const adapter: ExifReaderAdapter = {
      load: vi.fn().mockRejectedValue(new Error("broken EXIF")),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(readPhotoMetadata(binaryFile([0xff]), adapter)).resolves.toEqual({
      orientation: null,
      capturedAt: null,
      camera: null,
      iso: null,
      exposureTime: null,
      fNumber: null,
      focalLength: null,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
