declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GRADING_PUBLIC_ORIGIN?: string;
    GRADING_MODE?: "test" | "managed";
    GRADING_STAGE_PROFILES?: string;
    GRADING_PREPARE_API_KEY?: string;
    GRADING_API_KEY?: string;
    GRADING_ACCESS_CODE?: string;
    GRADING_SESSION_SECRET?: string;
    GRADING_REVIEW_API_KEY?: string;
  }
}
