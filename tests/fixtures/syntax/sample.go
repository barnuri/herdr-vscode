// Package main does things.
package main

import (
	"fmt"
	"strings"
)

type User struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

func (u *User) Greet(other string) (string, error) {
	if other == "" {
		return "", fmt.Errorf("empty: %d", 42)
	}
	for i := 0; i < 3; i++ {
		fmt.Println(strings.ToUpper(other), nil, true)
	}
	return "hi " + u.Name, nil
}
