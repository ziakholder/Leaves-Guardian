// Core Library Layer
export { LeavesClient, CLIENT_STATES } from './client/LeavesClient.js';
export { LeavesTerminal } from './client/LeavesTerminal.js';
export { SessionManager } from './client/SessionManager.js';
export { ReconnectManager, RECONNECT_REASONS } from './client/ReconnectManager.js';
export { ConnectionManager } from './client/ConnectionManager.js';
export { EventManager } from './client/EventManager.js';
export { LoggerAdapter } from './client/LoggerAdapter.js';

// Message Abstraction Layer
export { Message } from './message/Message.js';
export { MessageTypes } from './message/MessageTypes.js';
export { MessageNormalizer } from './message/MessageNormalizer.js';

// Error Hierarchy
export * from './errors/LeavesError.js';

// Reliability & Runtime Layer (Layer 3)
export { SmartStore, SmartStoreNamespace, CURRENT_STORE_VERSION, validateKey, validateNamespace, validateJSONValue, validateAndCalculateExpiry } from './smartstore/SmartStore.js';
export { SessionRecovery, SESSION_RECOVERY_CODES, SESSION_STATUS, isEligibleAuthFile } from './recovery/SessionRecovery.js';
export { HealthMonitor, HEALTH_STATUS, PROBE_STATUS, MONITOR_STATE, HEALTH_ERROR_CODES, DEFAULT_THRESHOLDS, validateThresholds } from './health/HealthMonitor.js';
export { Watchdog, WATCHDOG_STATE, WATCHDOG_ERROR_CODES, DEFAULT_WATCHDOG_OPTIONS, validateWatchdogOptions } from './watchdog/Watchdog.js';
export { MemoryGuard, MEMORY_GUARD_STATE, MEMORY_GUARD_LEVEL, MEMORY_ERROR_CODES, DEFAULT_MEMORY_GUARD_OPTIONS, DEFAULT_MEMORY_GUARD_STATUS, validateMemoryGuardOptions } from './memory/MemoryGuard.js';

// Traffic Control Layer (Layer 5.1)
export { TrafficController, TRAFFIC_STATE, TRAFFIC_PRIORITY, TRAFFIC_TASK_STATE, TRAFFIC_ERROR_CODES, DEFAULT_TRAFFIC_OPTIONS, validateTrafficOptions } from './traffic/TrafficController.js';

// Media Preparation & Reliability Layer (Layer 5.2)
export { MediaPipeline } from './media/MediaPipeline.js';
export { MediaJob } from './media/MediaJob.js';
export { PreparedMedia } from './media/PreparedMedia.js';
export { SourceResolver, validateSsrfDestination, isPrivateOrReservedIp } from './media/SourceResolver.js';
export { MimeDetector } from './media/MimeDetector.js';
export { OutputManager } from './media/OutputManager.js';
export { TransformerRegistry, WebpExifTransformer } from './media/TransformerRegistry.js';
export { MEDIA_ERROR_CODES, MEDIA_JOB_STATE, MEDIA_REPRESENTATION, MEDIA_TYPE, DEFAULT_MEDIA_OPTIONS, validateMediaOptions } from './media/MediaConstants.js';

// Ingress Rate Limiting Layer (Layer 5.3)
export { IngressRateLimiter } from './limiter/IngressRateLimiter.js';
export { RateLimitDecision } from './limiter/RateLimitDecision.js';
export { SlidingWindowTracker } from './limiter/SlidingWindowTracker.js';
export { LIMITER_STATE, RATE_LIMIT_ERROR_CODES, DEFAULT_RATE_LIMITER_OPTIONS, defaultKeyExtractor, validateRateLimiterOptions } from './limiter/RateLimitConstants.js';

// Ingress Deduplication Layer (Layer 5.4)
export { IngressDeduplicator } from './dedup/IngressDeduplicator.js';
export { DeduplicationResult } from './dedup/DeduplicationResult.js';
export { DeduplicationCache } from './dedup/DeduplicationCache.js';
export { DEDUP_STATE, DEDUP_ERROR_CODES, DEFAULT_DEDUPLICATOR_OPTIONS, defaultIdentityExtractor, validateDeduplicatorOptions } from './dedup/DeduplicatorConstants.js';

// Terminal Presentation Layer (Layer 5.5)
export { TerminalManager } from './terminal/TerminalManager.js';
export { TerminalEvent } from './terminal/TerminalEvent.js';
export { PresentationSanitizer } from './terminal/PresentationSanitizer.js';
export { PresentationAdapter } from './terminal/PresentationAdapter.js';
export { DefaultTextRenderer } from './terminal/TerminalRenderer.js';
export { DefaultDualSink, MemorySink } from './terminal/OutputSink.js';
export { getTerminalCapabilities } from './terminal/TerminalCapabilities.js';
export { TERMINAL_LEVEL, LEVEL_WEIGHTS, TERMINAL_DOMAIN, TERMINAL_STATE, RENDERER_STATUS, TERMINAL_ERROR_CODES, DEFAULT_TERMINAL_OPTIONS, validateTerminalOptions, extractRendererSafeOptions } from './terminal/TerminalConstants.js';


// Developer Utilities (Layer 4)
export { MessageCollector, COLLECTOR_END_REASONS } from './collector/MessageCollector.js';
export { Prompt, PROMPT_STATES } from './prompt/Prompt.js';
export { Paginator, PAGINATOR_STATES, PAGINATOR_ACTIONS } from './paginator/Paginator.js';
export { EphemeralMessage, EPHEMERAL_DURATIONS, DEFAULT_EPHEMERAL_DURATION } from './ephemeral/EphemeralMessage.js';
export { AutoDeleteManager, AutoDeleteTask, AUTODELETE_STATES, normalizeMessageKey, getCanonicalKeyIdentity, validateDelay } from './autodelete/AutoDeleteManager.js';

// Message Builders (Layer 1 - 100% Backward Compatible)
export { default as ListMessage } from './models/list-message.js';
export { default as ButtonMessage } from './models/button-message.js';
export { default as RichMessage } from './models/rich-message.js';
export { default as AIRichMessage } from './models/ai-rich-message.js';
export { default as TextMessage } from './models/text-message.js';
export { default as MediaMessage } from './models/media-message.js';
export { default as ProductMessage } from './models/product-message.js';
export { default as PollMessage } from './models/poll-message.js';
export { default as CarouselMessage } from './models/carousel-message.js';
export { default as CanvasMessage } from './models/canvas-message.js';
export { default as EventMessage } from './models/event-message.js';
export { default as StickerMessage } from './models/sticker-message.js';
export { default as BaseBuilder } from './models/base-builder.js';

// Helpers
export { default as withChannelForward } from './helpers/channel-forward.js';
export { default as withAdReply } from './helpers/ad-reply.js';
export { default as generateStatCard } from './helpers/stat-card.js';
export { default as resolveMedia } from './helpers/media-resolver.js';
export { default as resolveLidToPn } from './helpers/lid-resolver.js';

// Baileys Media & Content Primitives
export { downloadMediaMessage, downloadContentFromMessage, getContentType, normalizeMessageContent } from '@whiskeysockets/baileys';

