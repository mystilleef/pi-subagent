.DEFAULT_GOAL := verify

.PHONY: help verify coverage check migrate

help:
	@printf '%s\n' \
		'Available targets:' \
		'  verify    Run checks and tests' \
		'  coverage  Run checks and tests with coverage' \
		'  check     Fix lint issues and type-check' \
		'  migrate   Run Biome migrations'

verify:
	bun check && bun test

coverage:
	bun check && bun test --coverage

check:
	biome check --fix --unsafe . && tsc --noEmit

migrate:
	biome migrate --write
