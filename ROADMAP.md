# ROADMAP

This doc outlines roadmap items for the playtest tool,

- [ ] close the loop with JIRA integration
- [ ] Mobile testing support (drivers are in place, but path needs to be tested and iterated)
- [ ] REST API testing support (drivers are in place, but path needs to be tested and iterated)
- [ ] CI set up to build and upload playtest to artifactory npm registry
- [ ] Accessibility grading e.g. axe-core
- [ ] Lumen migration
- [ ] Test data setup / cleanup life cycle
- [ ] Code audit, repo clean up, proper docs
- [ ] Play around with discovery mode stories and polish it up
- [ ] Make context window visible / debuggable within trajectory viewer
- [ ] Trigger runs from the playtest viewer
- [ ] Hosted Playtest tooling (persisted data + wrapper rest api)
- [ ] Support for integrating playtest into existing CI's
- [ ] Review how model configs are set. Currently defaulted to portkey model names with env var overrides, but there's only one GPT default, which causes pricing estimates to be inaccurate if a model other than gpt 5.5 is used
- [ ] Add semantic linting to `Playtest lint <dir>` command. LLM reviews a playtest suite for cohesiveness, consistency, duplication, unecessary assertions (e.g. can any assertions be turned into programmatic checks?)
- [ ] Vision mode optimisation and DX (e.g. when model doesn't support vision, debugging in playtest viewer)
- [ ] ... add more
- [ ] normalise vision mode image sizes

## FABLE
- web & mobile driver performance
- design for test data set up
- find bugs
- how to improve discovery mode? Issue highlighting & JIRA integration?
- simplify the artifacts
- design doc for hosting this as a completely hosted write AND read web experience (read is done)
