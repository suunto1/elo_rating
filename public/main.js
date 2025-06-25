document.addEventListener("DOMContentLoaded", function() {
    console.log("DOMContentLoaded fired.");

    let nearestEventClickListener = null;

    updateNearestEvent();

    if (document.getElementById('calendar')) {
        console.log("Calendar element found. Initializing FullCalendar...");
        fetch('/api/events')
            .then(response => {
                console.log("API events fetch response:", response);
                if (!response.ok) {
                    throw new Error('Network response was not ok: ' + response.statusText);
                }
                return response.json();
            })
            .then(data => {
                console.log("API events data received for FullCalendar:", data);
                const events = data.events.map(event => ({
                    id: event.id,
                    title: event.description,
                    start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss')
                }));
                console.log("Processed events for FullCalendar:", events);

                const urlParams = new URLSearchParams(window.location.search);
                const highlightId = urlParams.get('highlightEvent');
                console.log("Highlight event ID from URL:", highlightId);

                $('#calendar').fullCalendar({
                    timeZone: 'Europe/Kiev',
                    header: {
                        left: 'prev,next today',
                        center: 'title',
                        right: 'month'
                    },
                    editable: false,
                    firstDay: 1,
                    events: events,
                    eventColor: '#3c5ca8',
                    eventTextColor: 'rgb(221, 221, 221)',
                    timeFormat: ' ',

                    dayRender: function(date, cell) {
                        if (moment().isSame(date, 'day')) {
                            cell.css('background-color', '#3c5ca8');
                        }
                    },
                    eventRender: function(event, element) {
                        console.log(`EventRender: Event ID: ${event.id}, Highlight ID: ${highlightId}, Title: ${event.title}`); // Отладка
                        if (highlightId && event.id == highlightId) {
                            element.addClass('highlighted-event');
                            console.log(`!!! EVENT HIGHLIGHTED: ${event.title} (ID: ${event.id})`); // Отладка
                        }
                    },
                    eventClick: function(event, jsEvent, view) {
                        // alert('Event: ' + event.title); // Пример использования
                    }
                });

                if (highlightId) {
                    const targetEvent = events.find(e => e.id == highlightId);
                    if (targetEvent) {
                        console.log("Target event for scrolling found:", targetEvent);
                        $('#calendar').fullCalendar('gotoDate', moment(targetEvent.start));
                        setTimeout(() => {
                            const highlightedEventElement = $('.highlighted-event');
                            if (highlightedEventElement.length) {
                                highlightedEventElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                                console.log("Scrolled to highlighted event element.");
                            } else {
                                console.log("Highlighted event element NOT found after timeout. Possible render issue or class not applied.");
                            }
                        }, 800);
                    } else {
                        console.log("Target event NOT found in events array for highlightId:", highlightId);
                    }
                } else {
                    console.log("No highlightEvent parameter in URL for calendar init.");
                }

            })
            .catch(error => {
                console.error('Error fetching events for calendar:', error);
            });
    }

    function updateNearestEvent() {
        console.log("updateNearestEvent called.");
        fetch('/api/events')
            .then(response => {
                console.log("Nearest event API response:", response);
                if (!response.ok) {
                    throw new Error('Network response was not ok: ' + response.statusText);
                }
                return response.json();
            })
            .then(data => {
                console.log("Nearest event API data for strip:", data);
                const events = data.events.map(event => ({
                    id: event.id,
                    title: event.description,
                    start: moment.tz(event.date, 'Europe/Kiev').format('YYYY-MM-DDTHH:mm:ss')
                }));
                console.log("All events from API for nearest:", events);

                const now = moment();
                const upcomingEvents = events.filter(event => moment(event.start).isAfter(now));
                console.log("Upcoming events:", upcomingEvents);

                const nearestEvent = upcomingEvents.reduce((prev, curr) => {
                    return moment(curr.start).isAfter(now) && (!prev || moment(curr.start).isBefore(prev.start)) ? curr : prev;
                }, null);
                console.log("Nearest event found:", nearestEvent);

                const upcomingEventStrip = document.getElementById('upcoming-event-strip');
                const eventTitle = document.getElementById('event-title');
                const eventDate = document.getElementById('event-date');

                if (nearestEvent) {
                    eventTitle.textContent = nearestEvent.title;
                    eventDate.textContent = moment(nearestEvent.start).format('DD MMM');
                    upcomingEventStrip.style.display = 'flex';
                    console.log("Upcoming event strip updated and visible.");

                    if (eventTitle) {
                        if (nearestEventClickListener) {
                            eventTitle.removeEventListener('click', nearestEventClickListener);
                            console.log("Removed old nearestEventClickListener.");
                        }

                        nearestEventClickListener = function() {
                            window.location.href = `/calendar?highlightEvent=${nearestEvent.id}`;
                            console.log(`Navigating to: /calendar?highlightEvent=${nearestEvent.id}`);
                        };
                        eventTitle.addEventListener('click', nearestEventClickListener);
                        console.log("Added new nearestEventClickListener.");
                    }

                } else {
                    eventTitle.textContent = "Наразі немає майбутніх подій";
                    eventDate.textContent = "";
                    upcomingEventStrip.style.display = 'none';
                    console.log("No nearest event found. Upcoming event strip hidden.");
                }
            })
            .catch(error => {
                console.error('Error fetching nearest event:', error);
                document.getElementById('event-title').textContent = "Помилка завантаження подій";
                document.getElementById('event-date').textContent = "";
                document.getElementById('upcoming-event-strip').style.display = 'none';
                console.log("Error occurred. Upcoming event strip hidden.");
            });
    }
});