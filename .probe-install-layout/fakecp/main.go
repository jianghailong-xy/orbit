// fakecp stands in for an Orbit control plane in the install-layout container run: it serves
// /install.sh and /dl/* from a directory, and answers POST /api/runner/register with a fixed
// credential. Every request is logged.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	dir, addr := os.Args[1], os.Args[2]
	mux := http.NewServeMux()
	mux.Handle("/dl/", http.StripPrefix("/dl/", http.FileServer(http.Dir(filepath.Join(dir, "dl")))))
	mux.HandleFunc("/install.sh", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(dir, "install.sh"))
	})
	mux.HandleFunc("/api/runner/register", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"runnerId": "runner-layout-demo", "runnerToken": "token-layout-demo", "name": body["name"].(string),
		})
	})
	mux.HandleFunc("/", http.NotFound)
	logged := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		mux.ServeHTTP(w, r)
	})
	log.Fatal(http.ListenAndServe(addr, logged))
}
