package app

// Media capability failures are converted to modelCapabilityArgumentError or
// ModelError at the shared task admission boundary. The Agent consumes those
// stable fields in model_capability_argument.go; no provider error text is
// parsed here.
