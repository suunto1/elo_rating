document.addEventListener("DOMContentLoaded", function() {
    fetch('/api/events')
        .then(response => response.json())
        .then(data => {
            const events = data.events.map(event => ({
                title: event.description,
                start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss')
            }));

            $('#calendar').fullCalendar({
                timeZone: 'Europe/Kiev',
                header: {
                    left: 'prev,next today',
                    center: 'title',
                    right: 'month'
                },
                editable: false,
                firstDay: 1,
                events: events
            });

            // Устанавливаем активный элемент меню после инициализации календаря
            setActiveMenuItem();

            // Находим ближайшее событие
            const now = moment();
            const nearestEvent = events.reduce((prev, curr) => {
                return moment(curr.start).isAfter(now) && (!prev || moment(curr.start).isBefore(prev.start)) ? curr : prev;
            }, null);

            // Сохраняем ближайшее событие в localStorage
            if (nearestEvent) {
                localStorage.setItem('nearestEvent', JSON.stringify(nearestEvent));
            }
        });

    function setActiveMenuItem() {
        var currentUrl = window.location.pathname;
        var menuItems = document.querySelectorAll('.menu a');
        menuItems.forEach(function(item) {
            if (item.getAttribute('href') === currentUrl) {
                item.classList.add('active');
            }
        });
    }
});
