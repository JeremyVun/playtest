variable "REGISTRY_DOMAIN" {}
target "common" { platforms = ["linux/amd64"] }
target "control-plane" { tags = ["${REGISTRY_DOMAIN}/playtest-control-plane:${RELEASE}"] }
target "runner" { tags = ["${REGISTRY_DOMAIN}/playtest-runner:${RELEASE}"] }
target "job" { tags = ["${REGISTRY_DOMAIN}/playtest-job:${RELEASE}"] }
