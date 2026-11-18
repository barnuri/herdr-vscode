# Comment
from dataclasses import dataclass
import os

@dataclass
class User:
    """A user.
    With a docstring."""
    id: int
    name: str = "anon"

    def greet(self, other: "User") -> str:
        if other is None or not self.name:
            raise ValueError(f"bad {other!r}")
        for i in range(10):
            print(i, os.path.join("a", "b"), True, None)
        return f"hi {self.name}"
