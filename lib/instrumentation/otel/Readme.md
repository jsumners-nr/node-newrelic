## Notes

+ OTEL refers to observability concerns as "signals". Traces, Metrics, and Logs are all examples of different signals.
+ It is worthwhile to read through https://opentelemetry.io/docs/concepts/signals/traces/
+ Traces, or transactions, are collections of "spans": https://opentelemetry.io/docs/specs/otel/overview/#traces
+ Contexts are used to store the state of traces: https://opentelemetry.io/docs/specs/otel/overview/#context-propagation
+ Propagators are used to serialize spans (and other signals): https://opentelemetry.io/docs/specs/otel/overview/#propagators
+ Resources are descriptors of entities being instrumented, e.g a Docker container and its associated metadata: https://opentelemetry.io/docs/specs/otel/resource/sdk/

## Concept Map

+ NR_Transaction => OTEL_Trace
+ NR_Segment => OTEL_Span
+ NR_Span => OTEL_Span

## References

OTEL:
+ Span spec: https://opentelemetry.io/docs/specs/otel/trace/api/#span
+ SpanContext spec: https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext

NR:
+ Trace spec: https://source.datanerd.us/agents/agent-specs/blob/main/Transaction-Trace-LEGACY.md
+ Span events: https://source.datanerd.us/agents/agent-specs/blob/main/Span-Events.md

## Identifiers

+ Trace id:
  + OTEL: 16-byte array of random bytes
  + NR: 
