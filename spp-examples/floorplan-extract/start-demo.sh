#!/bin/bash

# Script to start the Floor Plan Structure Extraction Demo
# Includes API proxy to avoid CORS issues
# Usage: ./start-demo.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"
node spp-examples/floorplan-extract/server.mjs
