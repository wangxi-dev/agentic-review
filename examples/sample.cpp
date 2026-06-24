#include <cmath>
#include <iostream>

// Sample C++ file to exercise the code renderer.
struct Point {
    double x;
    double y;

    double distance_to(const Point& other) const {
        double dx = x - other.x;
        double dy = y - other.y;
        return std::sqrt(dx * dx + dy * dy);
    }
};

int main() {
    Point a{0, 0};
    Point b{3, 4};
    std::cout << "distance: " << a.distance_to(b) << '\n';
    return 0;
}
