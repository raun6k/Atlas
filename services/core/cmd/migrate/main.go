package main

import (
	"context"
	"flag"
	"log"
	"os"

	"atlas.dev/core/internal/store"
)

func main() {
	url := flag.String("postgres-url", os.Getenv("ATLAS_POSTGRES_URL"), "atlas postgres url")
	dir := flag.String("dir", getenv("ATLAS_MIGRATIONS_DIR", "db/atlas/migrations"), "migrations directory")
	flag.Parse()
	if *url == "" {
		log.Fatal("ATLAS_POSTGRES_URL is required")
	}
	ctx := context.Background()
	db, err := store.Connect(ctx, *url)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx, *dir); err != nil {
		log.Fatal(err)
	}
	log.Println("atlas migrations applied")
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
