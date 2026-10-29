declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GRADING_MODE?: "test" | "managed";
    GRADING_PROVIDER?: "openai" | "deepseek";
    GRADING_API_KEY?: string;
    GRADING_ACCESS_CODE?: string;
    GRADING_SESSION_SECRET?: string;
    GRADING_REVIEW_PROFILE?: string;
    GRADING_REVIEW_API_KEY?: string;
  }
}
