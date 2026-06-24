"""Sample Python file to exercise the code renderer."""
from dataclasses import dataclass


@dataclass
class Point:
    x: float
    y: float

    def distance_to(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5


def main() -> None:
    a, b = Point(0, 0), Point(3, 4)
    print("distance:", a.distance_to(b))


if __name__ == "__main__":
    main()
