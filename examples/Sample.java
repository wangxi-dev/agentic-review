// Sample Java file to exercise the code renderer.
public class Sample {
    record Point(double x, double y) {
        double distanceTo(Point other) {
            double dx = x - other.x();
            double dy = y - other.y();
            return Math.sqrt(dx * dx + dy * dy);
        }
    }

    public static void main(String[] args) {
        var a = new Point(0, 0);
        var b = new Point(3, 4);
        System.out.println("distance: " + a.distanceTo(b));
    }
}
