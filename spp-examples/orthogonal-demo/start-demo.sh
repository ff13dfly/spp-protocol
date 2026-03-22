#!/bin/bash

# Script to start the Orthogonal Reconstruction Demo
# Usage: ./start-demo.sh

# Function to find an available port
find_port() {
    local port=$1
    while lsof -i :$port > /dev/null; do
        port=$((port + 1))
    done
    echo $port
}

PORT=$(find_port 53250)

echo "--------------------------------------------------"
echo "🚀 Starting SPP Orthogonal Demo on port $PORT..."
echo "--------------------------------------------------"
echo ""
echo "Access the Demo at:"
echo "👉 http://localhost:$PORT/"
echo ""
echo "--------------------------------------------------"

# Start the server (serving current directory)
npx -y serve -l $PORT .
