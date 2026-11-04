import { ApiError } from "../client/api";

/**
 * Turns the server's short error codes into a message a person can act on.
 * The codes come from the API envelope; the HTTP status is not exposed here.
 */
export function describeAnalysisError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "forbidden":
        return "This site is not allowed to use photo analysis (403). The app owner needs to add this site's exact address to ALLOWED_ORIGINS.";
      case "rate_limit":
        return "Too many photos were scanned just now (429). Wait a moment, then try again.";
      case "unavailable":
        // A network failure also arrives as "unavailable"; keep its connection advice.
        if (/could not reach|did not respond/i.test(error.message)) return error.message;
        return "Photo analysis is unavailable right now (503). The app's AI service may not be configured on this deployment; the owner can check MODEL_ENABLED, MUSE_API_KEY and MODEL_MAX_REQUESTS.";
      // The AI provider's own failures. Say what is wrong and what the visitor
      // or the site owner can do, without status codes or provider internals.
      case "ai_auth_failed":
        return "The AI key was rejected. If you run this site, check MUSE_API_KEY in the deployment settings, then redeploy. You can still enter the values yourself.";
      case "ai_billing":
        return "The AI account has no credits or billing set up. If you run this site, add credits in the Meta developer portal. You can still enter values yourself.";
      case "ai_forbidden":
        return "The AI provider refused this request — usually a region or key restriction. Enter the values yourself, or try again later.";
      case "ai_model_missing":
        return "The configured AI model wasn't found. If you run this site, check MUSE_MODEL (default muse-spark-1.2).";
      case "ai_rate_limited":
        return "The AI is rate-limiting right now. Wait a moment and retry, or enter the values yourself.";
      case "ai_timeout":
        return "The AI took too long to respond. Retake a closer, brighter photo, or enter the values yourself.";
      case "invalid_input":
      case "unsupported_media_type":
        return "That photo couldn't be read — retake it with the camera or choose a JPEG/PNG.";
      case "body_too_large":
        return "That photo is too large. Retake it with the camera or choose a smaller JPEG/PNG.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : "Photo analysis failed.";
}
