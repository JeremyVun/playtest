variable "RELEASE" { default = "local" }
variable "REVISION" { default = "local" }
group "default" { targets = ["control-plane", "runner", "job"] }
target "common" {
  context = "."
  dockerfile = "Dockerfile"
  args = { REVISION = REVISION }
}
target "control-plane" {
  inherits = ["common"]
  target = "control-plane"
  tags = ["playtest-control-plane:${RELEASE}"]
}
target "runner" {
  inherits = ["common"]
  target = "runner"
  tags = ["playtest-runner:${RELEASE}"]
}
target "job" {
  inherits = ["common"]
  target = "job"
  tags = ["playtest-job:${RELEASE}"]
}
