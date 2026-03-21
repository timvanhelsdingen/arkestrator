/**
 * Skill Templates — variable resolution for skill content at fetch time.
 *
 * Template variables are replaced with runtime context when a skill's
 * content is served to an agent.
 */

/**
 * Replace template variables in skill content with runtime values.
 *
 * Supported variables:
 * - {BRIDGE_LIST}         — comma-separated list of connected bridge programs
 * - {BRIDGE_CONTEXT}      — detailed bridge context string (programs, capabilities, etc.)
 * - {DEFAULT_PROJECT_DIR} — default project directory path for the current context
 */
export function resolveSkillTemplateVars(
  content: string,
  bridgeList: string,
  bridgeContext: string,
  defaultProjectDir: string,
): string {
  return content
    .replace(/\{BRIDGE_LIST\}/g, bridgeList)
    .replace(/\{BRIDGE_CONTEXT\}/g, bridgeContext)
    .replace(/\{DEFAULT_PROJECT_DIR\}/g, defaultProjectDir);
}
