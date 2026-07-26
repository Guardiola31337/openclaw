/** Tracks active and retired plugin registries so stale runtime calls can be rejected. */
import type { PluginRegistry } from "./registry-types.js";

const retiredRegistries = new WeakSet<PluginRegistry>();
const activatedRegistries = new WeakSet<PluginRegistry>();
const lifecycleListeners = new Set<() => void>();

function notifyPluginRegistryLifecycleListeners(): void {
  for (const listener of lifecycleListeners) {
    listener();
  }
}

/** Observe activation edges that can replace runtime-owned plugin capabilities. */
export function onPluginRegistryLifecycleChange(listener: () => void): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

/** Marks a registry retired so late runtime calls can reject stale plugin state. */
export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    retiredRegistries.add(registry);
    notifyPluginRegistryLifecycleListeners();
  }
}

/** Marks a registry active and clears any previous retired state. */
export function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void {
  if (registry) {
    activatedRegistries.add(registry);
    retiredRegistries.delete(registry);
    notifyPluginRegistryLifecycleListeners();
  }
}

/** True when a registry has been activated for runtime use. */
export function isPluginRegistryActivated(registry: PluginRegistry): boolean {
  return activatedRegistries.has(registry);
}

/** True when a registry has been retired by a newer active registry. */
export function isPluginRegistryRetired(registry: PluginRegistry): boolean {
  return retiredRegistries.has(registry);
}
