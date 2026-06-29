# bd-25f291 — finish /rt settings registry (drive apply dispatch)

Follow-up to bd-381522. Registry rows now carry setter + snapshotField; new
applyRealtimeValueParams(params, controls, ctx, {applyLocalVadEnergy}) drives the
value-setting dispatch in applyRealtimeParams (backend/baseUrl/model/azure*/voice/
trans/speed/thresh/energy/reasoning/summary/chime). energy=local-vad + fork are
special; pulse/lifecycle stay bespoke. Adding a /rt value setting is now a row +
setter. 2 new tests (setter/snapshotField declared; dispatch routes correctly).
Suite 1091/1091 keyless, npm run check OK. Direct (pr_auto_merge fleet verify
owned by msm-2 bd-721a38).
