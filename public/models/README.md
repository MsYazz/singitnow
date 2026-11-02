# Speech model for lyric timing

`ctc-en-small.int8.onnx` is NVIDIA NeMo's `stt_en_conformer_ctc_small`
(https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/stt_en_conformer_ctc_small),
exported to ONNX and int8-quantised by the sherpa-onnx project
(https://github.com/k2-fsa/sherpa-onnx, release `asr-models`; its model README lists Apache-2.0,
see NVIDIA's model card for the original terms).
`ctc-en-small.tokens.json` is its token list.

The app uses it only to find when each known lyric word is sung (forced alignment), on the device.

# Pitch model for the notes view

`fcpe.f16.onnx` is FCPE (`fcpe_c_v001`, bundled with the `torchfcpe` package, MIT licence,
https://github.com/CNChTu/FCPE), exported to ONNX without its mel front end (the app computes the
128-band log-mel itself, see `src/lib/audio/pitch.ts`) and with its weights stored as float16
(results match the float32 model to within 0.02 cents). It gives the pitch of a singing voice
every 10 ms, on the device.
