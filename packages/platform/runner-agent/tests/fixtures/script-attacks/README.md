# Adversarial script fixtures

Each file is a hostile Playtest script used by
`../../unit/script-boundary.test.ts` to prove the hosted script-execution
boundary (`docs/contracts/hosted.md#script-execution-boundary`). They are written
to REPORT what they managed to do rather than to crash, so the test can assert
both the script's own view of the sandbox and the parent's independent record of
it. Every attempt must come back blocked or provably credential-free.
